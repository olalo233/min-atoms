import type { Hono } from "hono";
import { ManagerKickRequestSchema, ManagerAbortRequestSchema } from "@min-atoms/protocol";
import type { DurableEvents, HeartbeatTimers } from "./events";
import { ManagerError, validateProjectId } from "./errors";
import type { ProjectRuntime } from "./runtime";
import type { QueuedRun, RunStore, FinishRun } from "./store";
import { OmpRpc, stopFailureContent, type RpcTransport, type RpcTimers } from "./omp-rpc";
import { OmpEventMapper, RunBuffer } from "./run-events";
import { spawnOmp, runCommand, type RunCommand } from "./run-process";
import type { createManager } from "./manager";

type Active = {
  run: QueuedRun; phase: string; cancelled: boolean; spawned: boolean;
  signal: AbortController; rpc?: OmpRpc; aborting?: Promise<void>; stopFailed?: boolean;
};
type Queue = { dirty: boolean; task: Promise<void> };
const cancelled = () => new Error("Run cancelled");

export function createRunDriver(options: {
  store: RunStore; runtime: Pick<ProjectRuntime, "project" | "ensure" | "restart">; events: DurableEvents;
  spawn?: (container: string, mode: "build" | "chat") => RpcTransport;
  command?: RunCommand; now?: () => number; timers?: HeartbeatTimers; rpcTimers?: RpcTimers;
  onError?: (error: unknown) => void;
}) {
  const { store, runtime, events } = options;
  const now = options.now ?? Date.now;
  const command = options.command ?? runCommand;
  const active = new Map<string, Active>();
  const queues = new Map<string, Queue>();
  const guard = (state: Active) => { if (state.cancelled) throw cancelled(); };

  async function execute(projectId: string, label: string, state: Active) {
    const backlog = await store.backlog(projectId, 0);
    const seq = backlog.filter(row => row.event.runId === state.run.id).at(-1)?.event.seq ?? 0;
    const buffer = new RunBuffer(events, projectId, state.run.id, seq, now, options.timers);
    const mapper = new OmpEventMapper(body => buffer.add(body));
    const phase = (status: "starting" | "running" | "verifying" | "repairing" | "committing", detail?: string) => {
      guard(state); state.phase = status; buffer.add({ kind: "status", status, ...(detail ? { detail } : {}) });
    };
    let terminal: FinishRun | undefined;
    async function prompt(message: string) {
      guard(state);
      const result = await state.rpc!.prompt(message);
      guard(state);
      if (result.status !== "completed") throw new Error(result.error?.message ?? "OMP 未完成本次运行");
    }
    try {
      phase("starting");
      // Claim precedes ensure: LRU sees this executing run as running.
      guard(state); await runtime.ensure(projectId, label); guard(state);
      state.rpc = new OmpRpc(options.spawn ? options.spawn(label, state.run.mode)
        : spawnOmp(label, state.run.mode, () => runtime.restart(projectId, label)), frame => mapper.receive(frame), options.rpcTimers);
      state.spawned = true;
      await state.rpc.open(state.run.mode, state.signal.signal); guard(state);
      phase("running"); await prompt(state.run.content);
      if (state.run.mode === "build") {
        let failure = "";
        for (let attempt = 0; attempt <= 2; attempt++) {
          phase("verifying");
          const check = await command(label, ["bun", "run", "check"], state.signal.signal); guard(state);
          failure = check.exitCode === 0 ? "" : check.output || "bun run check 失败";
          if (!failure) {
            for (const path of ["/", "/api/health"]) {
              guard(state);
              const health = await command(label, ["curl", "--fail", "--silent", "--show-error", "--max-time", "10",
                `http://localhost:5173${path}`], state.signal.signal); guard(state);
              if (health.exitCode !== 0) { failure = health.output || `${path} 健康检查失败`; break; }
            }
          }
          if (!failure) break;
          if (attempt === 2) throw new Error(`构建未通过：${failure.slice(-4000)}`);
          phase("repairing", `发现问题，自动修复中（第 ${attempt + 1}/2 轮）…`);
          await prompt(`请修复以下问题\n${failure.slice(-4000)}`);
        }
        guard(state);
        const version = await store.versionState(projectId); guard(state);
        // No await between the last cancellation check and committing.
        phase("committing"); await buffer.flush();
        const summary = mapper.lastText.split("\n")[0].slice(0, 80);
        const add = await command(label, ["git", "add", "-A"]);
        if (add.exitCode !== 0) throw new Error("无法暂存版本");
        const commit = await command(label, ["git", "commit", "--allow-empty", "-m", `v${version.next}: ${summary}`]);
        if (commit.exitCode !== 0) throw new Error("无法保存版本");
        const sha = await command(label, ["git", "rev-parse", "HEAD"]);
        const commitSha = sha.output.trim();
        if (sha.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(commitSha)) throw new Error("无法读取版本提交");
        let screenshot = false;
        try {
          const directory = await command(label, ["mkdir", "-p", "/state/shots"]);
          if (directory.exitCode === 0) screenshot = (await command(label, ["chromium", "--headless=new", "--no-sandbox",
            `--screenshot=/state/shots/${commitSha}.png`, "--window-size=1280,800", "http://localhost:5173/"])).exitCode === 0;
        } catch { /* Screenshot failure is nonfatal. */ }
        terminal = { runId: state.run.id, expected: "running", status: "succeeded", now: new Date(now()),
          content: mapper.lastText, version: { number: version.next, commitSha, summary, screenshot } };
      } else {
        guard(state);
        terminal = { runId: state.run.id, expected: "running", status: "succeeded", now: new Date(now()), content: mapper.lastText };
      }
    } catch (error) {
      terminal = { runId: state.run.id, expected: "running", status: "failed", now: new Date(now()),
        content: (error instanceof Error ? error.message : "") || "运行失败" };
    } finally {
      try {
        if (state.aborting) await state.aborting;
        if (state.rpc) {
          try { await state.rpc.close(); }
          catch (error) {
            if (!state.stopFailed) terminal = { runId: state.run.id, expected: "running", status: "failed",
              now: new Date(now()), content: error instanceof Error ? error.message : "运行失败" };
          }
        }
      } finally { await buffer.close(); }
    }
    // Recheck after closing as abort can arrive during a check failure or a
    // graceful close. No workspace cleanup ever occurs for chat/pre-spawn.
    if (state.cancelled) {
      if (state.aborting) await state.aborting;
      let content = state.run.mode === "chat" ? "已停止讨论，应用未更改" : "已取消，应用未更改";
      let status: "cancelled" | "failed" = "cancelled";
      if (state.stopFailed) {
        status = "failed"; content = stopFailureContent;
      } else if (state.run.mode === "build" && state.spawned) {
        try {
          const stash = await command(label, ["git", "stash", "push", "-u", "-m", `run-${state.run.id}`]);
          if (stash.exitCode !== 0) throw new Error("Cancelled build cleanup failed");
          const { current } = await store.versionState(projectId);
          content = current === null ? "已停止，应用已回到初始状态" : `已停止，应用已回到版本 ${current}`;
        } catch (error) {
          status = "failed"; content = error instanceof Error ? error.message : "运行失败";
        }
      }
      terminal = { runId: state.run.id, expected: "running", status, now: new Date(now()), content };
    }

    state.phase = "terminal";
    if (terminal) await events.finish(projectId, terminal);
  }

  async function drain(projectId: string, label: string, queue: Queue) {
    do {
      queue.dirty = false;
      if (await store.running(projectId)) return;
      const run = await store.nextRun(projectId);
      if (!run) {
        if (queue.dirty) continue;
        // Remove synchronously with the idle decision. A kick after this point
        // creates a fresh drain instead of marking an already-finished one.
        queues.delete(projectId);
        return;
      }
      const state: Active = { run, phase: "starting", spawned: false, cancelled: false, signal: new AbortController() };
      active.set(projectId, state);
      try {
        if (await store.claim(projectId, run.id, new Date(now()))) await execute(projectId, label, state);
      } finally { active.delete(projectId); }
      queue.dirty = true;
    } while (queue.dirty);
  }

  async function kick(projectId: string, previewLabel?: string) {
    const project = await runtime.project(projectId, previewLabel);
    const existing = queues.get(project.id);
    if (existing) { existing.dirty = true; return; }
    // Publish queue state before starting the async drain. Kicks resolve after
    // scheduling, including initialize's recovery kicks.
    const queue: Queue = { dirty: true, task: Promise.resolve() };
    queues.set(project.id, queue);
    queue.task = drain(project.id, project.previewLabel, queue).catch(error => {
      options.onError?.(error);
    }).finally(() => { if (queues.get(project.id) === queue) queues.delete(project.id); });
  }

  async function abort(projectId: string, runId: string) {
    const project = await runtime.project(projectId);
    validateProjectId(runId);
    let run = await store.run(project.id, runId);
    if (!run) throw new ManagerError(404, "Run not found");
    if (run.status === "queued") {
      const records = await events.finish(project.id, { runId: run.id, expected: "queued", status: "cancelled",
        content: "已取消排队", now: new Date(now()) });
      if (records.length) return;
      run = await store.run(project.id, runId);
    }
    if (!run || run.status !== "running") throw new ManagerError(409, "Run already ended");
    const state = active.get(project.id);
    if (!state || state.run.id !== run.id) throw new ManagerError(503, "Run is not active in this manager");
    if (state.phase === "committing" || state.phase === "terminal") throw new ManagerError(409, "Version is being saved");
    state.cancelled = true;
    state.signal.abort();
    if (state.rpc) state.aborting ??= state.rpc.abort(state.run.mode === "build")
      .catch(() => { state.stopFailed = true; });
    if (state.aborting) await state.aborting;
  }
  return { kick, abort, async idle(projectId: string) { await queues.get(projectId)?.task; } };
}

export function registerRunRoutes(app: Hono, driver: ReturnType<typeof createRunDriver>) {
  app.post("/projects/:id/kick", async c => {
    validateProjectId(c.req.param("id"));
    const body = ManagerKickRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) throw new ManagerError(400, "Invalid kick body");
    await driver.kick(c.req.param("id"), body.data.previewLabel);
    return c.json({});
  });
  app.post("/projects/:id/runs/:runId/abort", async c => {
    const body = ManagerAbortRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) throw new ManagerError(400, "Invalid abort body");
    await driver.abort(c.req.param("id"), c.req.param("runId"));
    return c.json({});
  });
}

export function installRunDriver(manager: ReturnType<typeof createManager>) {
  const driver = createRunDriver({ ...manager, store: manager.store as RunStore,
    onError: () => console.error("Run drain failed; interrupted work requires recovery") });
  registerRunRoutes(manager.app, driver);
  return driver.kick;
}
