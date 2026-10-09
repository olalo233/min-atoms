import { afterAll, beforeAll, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq, sql } from "drizzle-orm";
import { appendMessage } from "@min-atoms/db";
import * as schema from "@min-atoms/db/schema";
import type { RunEvent } from "@min-atoms/protocol";
import { createManagerStore } from "../src/store";
import { DurableEvents } from "../src/events";
import { createRunDriver, registerRunRoutes } from "../src/run-driver";
import { createManagerApp } from "../src/app";
import { OmpRpc, type Frame, type RpcTimers, type RpcTransport } from "../src/omp-rpc";
import { OmpEventMapper, toolTitle } from "../src/run-events";
import { buildTools, chatTools, type RunCommand } from "../src/run-process";
import { ControlledTimers, at, deferred, label, secret, origin, auth } from "./helpers";
import type { ProjectRuntime } from "../src/runtime";
import { harness as runtimeHarness } from "./helpers";

const client = new PGlite();
const db = drizzle(client, { schema });
const store = createManagerStore(db);
let owner: string;
let serial = 5000;
beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url)) });
  [owner] = (await db.insert(schema.users).values({ username: "t12", passwordHash: "test" }).returning()).map(row => row.id);
}, 30_000);
afterAll(async () => { await client.close(); });
async function project() {
  const previewLabel = label(++serial);
  await db.insert(schema.previewHosts).values({ label: previewLabel });
  const [p] = await db.insert(schema.projects).values({ ownerId: owner, previewLabel, name: "test" }).returning();
  return p;
}
async function queue(projectId: string, mode: "build" | "chat" = "build", content = "request") {
  return db.transaction(async tx => {
    const m = await appendMessage(tx, projectId, { role: "user", mode, content, runId: null, versionId: null });
    const [r] = await tx.insert(schema.runs).values({ projectId, mode, status: "queued", userMessageId: m.id }).returning();
    return r;
  });
}
async function until(condition: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 1000; i++) { if (await condition()) return; await Bun.sleep(1); }
  throw new Error("Controlled test boundary was not reached");
}
class Timers implements RpcTimers {
  entries = new Set<{ callback: () => void; ms: number }>();
  after(callback: () => void, ms: number) { const entry = { callback, ms }; this.entries.add(entry); return () => { this.entries.delete(entry); }; }
  expire(ms: number) { for (const entry of [...this.entries]) if (entry.ms === ms) { this.entries.delete(entry); entry.callback(); } }
}
// All frames here are explicitly synthetic, except the fixture replay below.
class FakeRpc implements RpcTransport {
  readonly exit = deferred<number>();
  exited = this.exit.promise;
  stdout: ReadableStream<Uint8Array>;
  controller!: ReadableStreamDefaultController<Uint8Array>;
  commands: Frame[] = [];
  closed = false;
  cleaned = false;
  killed = false;
  tools = ["read", "grep", "glob"];
  auto = true;
  abortSettles = true;
  status = "completed";
  text = "应用完成\n细节";
  onPrompt?: (frame: Frame) => void;
  constructor(readonly log: string[] = []) {
    this.stdout = new ReadableStream({ start: controller => { this.controller = controller; } });
    this.emit({ type: "ready", protocolVersion: 1 });
  }
  emit(frame: Frame) { if (!this.closed) this.controller.enqueue(new TextEncoder().encode(JSON.stringify(frame) + "\n")); }
  finish(id = [...this.commands].reverse().find(f => f.type === "prompt")!.id, settled = true) {
    this.emit({ type: "prompt_result", id, status: this.status, sessionSettled: settled });
  }
  send(line: string) {
    const frame = JSON.parse(line); this.commands.push(frame); this.log.push(frame.type);
    if (frame.type === "open_session") this.emit({ type: "response", id: frame.id, command: frame.type, success: true, data: { cancelled: false } });
    if (frame.type === "get_state") this.emit({ type: "response", id: frame.id, command: frame.type, success: true, data: { dumpTools: this.tools.map(name => ({ name })) } });
    if (frame.type === "prompt") {
      this.onPrompt?.(frame);
      if (this.auto) {
        this.emit({ type: "message_start", message: { role: "assistant" } });
        this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: this.text } });
        this.finish(frame.id);
      }
    }
    if (frame.type === "abort") {
      this.emit({ type: "response", command: "abort", id: frame.id, success: true });
      if (this.abortSettles && this.commands.some(f => f.type === "prompt")) {
        this.status = "aborted"; this.finish();
      }
    }
  }
  close() { this.log.push("close"); if (!this.closed) { this.closed = true; this.controller.close(); this.exit.resolve(0); } }
  kill() { this.killed = true; this.log.push("kill"); this.close(); }
  async cleanup() { this.cleaned = true; this.log.push("restart"); this.log.push("ready"); return true; }
}
async function harness() {
  const p = await project();
  const events = new DurableEvents(store);
  const records: RunEvent[] = [];
  events.subscribe(p.id, row => records.push(row.event));
  const log: string[] = [];
  const invocations: FakeRpc[] = [];
  const commands: string[][] = [];
  const timers = new ControlledTimers();
  const rpcTimers = new Timers();
  let configure = (_rpc: FakeRpc) => {};
  let checkFailures = 0;
  let priorChanges = true;
  let ensure = async () => { log.push("ensure"); expect(await store.running(p.id)).toBe(true); };
  let hook: RunCommand | undefined;
  const runtime = {
    async project(id: string, previewLabel?: string) {
      const row = await store.project(id);
      if (!row) throw new Error("missing project");
      if (previewLabel && row.previewLabel !== previewLabel) throw new Error("mismatched label");
      return row;
    },
    ensure: async () => ensure(),
    restart: async () => true,
  };
  const driver = createRunDriver({ store, runtime, events, timers, rpcTimers,
    now: () => Date.parse(at),
    spawn(_container, _mode) { log.push("spawn"); const rpc = new FakeRpc(log); configure(rpc); invocations.push(rpc); return rpc; },
    command: async (container, argv, signal) => {
      commands.push(argv); log.push(argv.slice(0, 2).join(" "));
      if (hook) return hook(container, argv, signal);
      if (argv[0] === "bun" && checkFailures-- > 0) return { exitCode: 1, output: "typecheck failure" };
      if (argv[0] === "git" && argv[1] === "stash") priorChanges = false;
      return { exitCode: argv[0] === "chromium" ? 1 : 0, output: argv[1] === "rev-parse" ? "a".repeat(40) : "" };
    }, onError: error => { errors.push(error); },
  });
  const errors: unknown[] = [];
  return { p, events, driver, records, invocations, commands, timers, rpcTimers, log, runtime, errors,
    configure(fn: typeof configure) { configure = fn; }, setEnsure(fn: typeof ensure) { ensure = fn; },
    setHook(fn: RunCommand) { hook = fn; }, failChecks(n: number) { checkFailures = n; },
    priorChanges: () => priorChanges,
  };
}
async function terminal(projectId: string, runId: string, detail: string, status: "cancelled" | "failed" = "cancelled") {
  const [m] = (await db.select().from(schema.messages).where(eq(schema.messages.runId, runId))).filter(m => m.role === "assistant");
  const rows = await store.backlog(projectId, 0);
  const event = rows.map(r => r.event).reverse().find(e => e.runId === runId && e.kind === "status");
  expect(event).toMatchObject({ kind: "status", status, detail });
  expect(m.content).toBe(detail);
  expect((await store.run(projectId, runId))?.status).toBe(status);
  expect(rows.filter(r => r.event.runId === runId && r.event.kind === "status" && r.event.status === status)).toHaveLength(1);
  expect((await db.select().from(schema.messages).where(eq(schema.messages.runId, runId))).filter(m => m.role === "assistant")).toHaveLength(1);
}

test("kick schedules immediately, uses canonical project IDs and serial message order; successful build creates version after checks", async () => {
  const h = await harness(); const first = await queue(h.p.id); const second = await queue(h.p.id, "chat", "next message");
  const gate = deferred<void>();
  h.setEnsure(async () => { await gate.promise; });
  await h.driver.kick(h.p.id.toUpperCase(), h.p.previewLabel);
  await h.driver.kick(h.p.id);
  await until(async () => (await store.run(h.p.id, first.id))?.status === "running");
  expect(h.invocations).toHaveLength(0);
  expect((await store.run(h.p.id, second.id))?.status).toBe("queued");
  gate.resolve(); await h.driver.idle(h.p.id);
  expect(h.errors).toEqual([]);
  expect(h.invocations).toHaveLength(2);
  expect(h.invocations.map(r => r.commands.find(c => c.type === "prompt")?.message)).toEqual(["request", "next message"]);
  expect(h.invocations.every(r => r.closed)).toBe(true);
  const phases = h.records.filter(e => e.runId === first.id && e.kind === "status").map(e => e.kind === "status" ? e.status : "");
  expect(phases).toEqual(["starting", "running", "verifying", "committing", "succeeded"]);
  expect(h.commands.slice(0, 3)).toEqual([["bun", "run", "check"], ["curl", "--fail", "--silent", "--show-error", "--max-time", "10", "http://localhost:5173/"], ["curl", "--fail", "--silent", "--show-error", "--max-time", "10", "http://localhost:5173/api/health"]]);
  const [version] = await db.select().from(schema.versions).where(eq(schema.versions.projectId, h.p.id));
  expect(version).toMatchObject({ number: 1, runId: first.id, screenshot: false, summary: "应用完成" });
  const [p] = await db.select().from(schema.projects).where(eq(schema.projects.id, h.p.id)); expect(p.currentVersionId).toBe(version.id);
  expect((await store.run(h.p.id, second.id))?.status).toBe("succeeded");
  expect(h.invocations[1].commands.map(c => c.type)).toEqual(["open_session", "get_state", "prompt"]);
  expect(h.timers.intervals).toEqual([250, 250]);
  expect(buildTools).toBe("read,write,edit,bash,eval,grep,glob,todo"); expect(chatTools).toBe("read,grep,glob");
});

test("a kick during an idle query does not strand newly queued work; duplicate kicks execute once", async () => {
  const h = await harness(); const waiting = deferred<void>(); const release = deferred<void>();
  let once = true;
  const proxied = { ...store, async nextRun(projectId: string) {
    const row = await store.nextRun(projectId);
    if (once && !row) { once = false; waiting.resolve(); await release.promise; }
    return row;
  } };
  const driver = createRunDriver({ store: proxied, runtime: h.runtime, events: h.events,
    spawn: () => new FakeRpc(), command: async () => ({ exitCode: 0, output: "" }) });
  await driver.kick(h.p.id); await waiting.promise;
  const r = await queue(h.p.id, "chat"); await driver.kick(h.p.id); await driver.kick(h.p.id); release.resolve();
  await driver.idle(h.p.id);
  expect((await store.run(h.p.id, r.id))?.status).toBe("succeeded");
  expect((await db.select().from(schema.messages).where(eq(schema.messages.runId, r.id))).filter(m => m.role === "assistant")).toHaveLength(1);
  const next = await queue(h.p.id, "chat"); await driver.kick(h.p.id); await driver.idle(h.p.id);
  expect((await store.run(h.p.id, next.id))?.status).toBe("succeeded");
});

test("two repair prompts share the original process, then failure keeps changes and creates no version", async () => {
  const h = await harness(); const r = await queue(h.p.id); h.failChecks(3);
  await h.driver.kick(h.p.id); await h.driver.idle(h.p.id);
  expect(h.invocations).toHaveLength(1);
  expect(h.invocations[0].commands.filter(c => c.type === "prompt").map(c => c.message)).toEqual(["request", "请修复以下问题\ntypecheck failure", "请修复以下问题\ntypecheck failure"]);
  expect(h.records.filter(e => e.kind === "status" && e.status === "repairing")).toHaveLength(2);
  expect((await store.run(h.p.id, r.id))?.status).toBe("failed");
  expect(h.commands.some(c => c[0] === "git")).toBe(false); expect(h.priorChanges()).toBe(true);
  expect(await db.select().from(schema.versions).where(eq(schema.versions.projectId, h.p.id))).toEqual([]);
});

test("repair succeeds on same transport and summary uses the last visible first line capped at 80", async () => {
  const h = await harness(); const r = await queue(h.p.id); h.failChecks(1);
  h.configure(rpc => { rpc.onPrompt = () => { if (rpc.commands.filter(c => c.type === "prompt").length === 2) rpc.text = "x".repeat(100) + "\nlast"; }; });
  await h.driver.kick(h.p.id); await h.driver.idle(h.p.id);
  expect(h.invocations).toHaveLength(1);
  const [v] = await db.select().from(schema.versions).where(eq(schema.versions.runId, r.id));
  expect(v.summary).toBe("x".repeat(80));
});

test("chat verifies actual effective tools and fails before prompt on an extra/missing/duplicate tool without cleanup", async () => {
  for (const tools of [["read", "grep", "glob", "bash"], ["read", "glob"], ["read", "read", "glob"]]) {
    const h = await harness(); const r = await queue(h.p.id, "chat"); h.configure(rpc => { rpc.tools = tools; });
    await h.driver.kick(h.p.id); await h.driver.idle(h.p.id);
    expect(h.invocations[0].commands.some(c => c.type === "prompt")).toBe(false);
    expect((await store.run(h.p.id, r.id))?.status).toBe("failed"); expect(h.commands).toEqual([]); expect(h.priorChanges()).toBe(true);
  }
});

test("queued cancellation affects only target, with no ensure/spawn/stash or active-run interference", async () => {
  const h = await harness(); const active = await queue(h.p.id, "chat"); const target = await queue(h.p.id);
  h.configure(rpc => { rpc.auto = false; });
  await h.driver.kick(h.p.id); await until(() => h.invocations[0]?.commands.some(c => c.type === "prompt") ?? false);
  const log = [...h.log]; await h.driver.abort(h.p.id, target.id);
  expect(h.log).toEqual(log); await terminal(h.p.id, target.id, "已取消排队");
  expect((await store.run(h.p.id, active.id))?.status).toBe("running");
  h.invocations[0].finish(); await h.driver.idle(h.p.id);
  await expect(h.driver.abort(h.p.id, target.id)).rejects.toMatchObject({ status: 409 });
});

test("claim and queued-cancel conditional updates cannot both win, in either ordering", async () => {
  for (const cancelFirst of [false, true]) {
    const p = await project(); const r = await queue(p.id); const events = new DurableEvents(store);
    const claim = () => store.claim(p.id, r.id, new Date(at));
    const cancel = () => events.finish(p.id, { runId: r.id, expected: "queued", status: "cancelled", content: "已取消排队", now: new Date(at) });
    const results = cancelFirst ? await Promise.all([cancel(), claim()]) : await Promise.all([claim(), cancel()]);
    const claimed = cancelFirst ? results[1] : results[0]; const records = (cancelFirst ? results[0] : results[1]) as unknown[];
    expect(Number(claimed) + Number(records.length > 0)).toBe(1);
  }
});

test("lost queued-cancel race routes to the active invocation and does not cancel another run", async () => {
  const h = await harness(); const r = await queue(h.p.id, "chat"); const queued = await queue(h.p.id, "chat");
  h.configure(rpc => { rpc.auto = false; });
  const read = store.run.bind(store); let stale = true;
  const proxy = { ...store, async run(projectId: string, runId: string) {
    const row = await read(projectId, runId); if (stale && runId === r.id) { stale = false; return row && { ...row, status: "queued" as const }; } return row;
  } };
  const driver = createRunDriver({ store: proxy, events: h.events, runtime: h.runtime, spawn: () => { const rpc = new FakeRpc(h.log); rpc.auto = false; h.invocations.push(rpc); return rpc; } });
  await driver.kick(h.p.id); await until(() => h.invocations[0]?.commands.some(c => c.type === "prompt") ?? false);
  await driver.abort(h.p.id, r.id); await until(async () => (await store.run(h.p.id, r.id))?.status === "cancelled");
  await terminal(h.p.id, r.id, "已停止讨论，应用未更改");
  await until(() => h.invocations.length === 2);
  expect((await store.run(h.p.id, queued.id))?.status).toBe("running");
  h.invocations[1].finish(); await driver.idle(h.p.id);
});

test("pre-spawn build cancellation preserves prior changes and writes exact starting cancellation text", async () => {
  const h = await harness(); const r = await queue(h.p.id); const entered = deferred<void>(); const release = deferred<void>();
  h.setEnsure(async () => { entered.resolve(); await release.promise; });
  await h.driver.kick(h.p.id); await entered.promise; await h.driver.abort(h.p.id, r.id); release.resolve(); await h.driver.idle(h.p.id);
  expect(h.invocations).toEqual([]); expect(h.commands).toEqual([]); expect(h.priorChanges()).toBe(true);
  expect(h.log.includes("restart")).toBe(false);
  await terminal(h.p.id, r.id, "已取消，应用未更改");
});

test("chat cancellation preserves failed-build changes, including when omp is already running", async () => {
  const h = await harness(); const r = await queue(h.p.id, "chat"); h.configure(rpc => { rpc.auto = false; });
  await h.driver.kick(h.p.id); await until(() => h.invocations[0]?.commands.some(c => c.type === "prompt") ?? false);
  await h.driver.abort(h.p.id, r.id); await h.driver.idle(h.p.id);
  expect(h.commands).toEqual([]); expect(h.priorChanges()).toBe(true);
  expect(h.invocations[0].cleaned).toBe(false);
  await terminal(h.p.id, r.id, "已停止讨论，应用未更改");
});

test("spawned build cancellation aborts, kills host exec, restarts, waits ready then stashes with current-version or initial-state text", async () => {
  for (const stage of ["running", "repairing"] as const) for (const current of [null, 7]) {
    const h = await harness(); const r = await queue(h.p.id); const ready = deferred<boolean>();
    if (current !== null) {
      const [v] = await db.insert(schema.versions).values({ projectId: h.p.id, number: current, commitSha: "b".repeat(40), summary: "prior" }).returning();
      await db.update(schema.projects).set({ currentVersionId: v.id }).where(eq(schema.projects.id, h.p.id));
    }
    if (stage === "repairing") h.failChecks(1);
    h.configure(rpc => {
      rpc.auto = stage === "repairing";
      rpc.onPrompt = () => { if (rpc.commands.filter(c => c.type === "prompt").length === 2) rpc.auto = false; };
      rpc.cleanup = async () => {
        rpc.cleaned = true; h.log.push("restart");
        const result = await ready.promise; h.log.push("ready"); return result;
      };
    });
    await h.driver.kick(h.p.id);
    await until(() => h.invocations[0]?.commands.filter(c => c.type === "prompt").length === (stage === "repairing" ? 2 : 1));
    const abort = h.driver.abort(h.p.id, r.id);
    await until(() => h.log.includes("restart"));
    expect(h.commands.some(c => c[1] === "stash")).toBe(false);
    expect((await store.run(h.p.id, r.id))?.status).toBe("running");
    ready.resolve(true); await abort; await h.driver.idle(h.p.id);
    expect(h.commands.filter(c => c[0] === "git")).toEqual([["git", "stash", "push", "-u", "-m", `run-${r.id}`]]);
    expect(h.log.filter(s => ["abort", "kill", "restart", "ready", "git stash"].includes(s))).toEqual(["abort", "kill", "restart", "ready", "git stash"]);
    expect(h.invocations[0].cleaned).toBe(true);
    expect(h.errors).toEqual([]);
    await terminal(h.p.id, r.id, current === null ? "已停止，应用已回到初始状态" : "已停止，应用已回到版本 7");
  }
});

test("in-flight bash abort exceeds 5s, then host exec terminates and a single restart precedes stash", async () => {
  const h = await harness(); const r = await queue(h.p.id);
  h.configure(rpc => { rpc.auto = false; rpc.abortSettles = false; rpc.onPrompt = () => rpc.emit({ type: "tool_execution_start", toolName: "bash", toolCallId: "in-flight", args: { command: "long command" } }); });
  await h.driver.kick(h.p.id); await until(() => h.invocations[0]?.commands.some(c => c.type === "prompt") ?? false);
  const abort = h.driver.abort(h.p.id, r.id); await until(() => h.invocations[0].commands.some(c => c.type === "abort"));
  expect(h.invocations[0].killed).toBe(false); expect(h.commands).toEqual([]);
  expect([...h.rpcTimers.entries].some(e => e.ms === 5000)).toBe(true); h.rpcTimers.expire(5000);
  await abort; await h.driver.idle(h.p.id);
  expect(h.invocations[0].cleaned).toBe(true); expect(h.invocations[0].killed).toBe(true);
  expect(h.log.filter(s => ["abort", "kill", "restart", "ready", "git stash"].includes(s))).toEqual(["abort", "kill", "restart", "ready", "git stash"]);
  await terminal(h.p.id, r.id, "已停止，应用已回到初始状态");
});

test("chat abort timeout restarts once and preserves files without stash", async () => {
  const h = await harness(); const r = await queue(h.p.id, "chat");
  h.configure(rpc => { rpc.auto = false; rpc.abortSettles = false; });
  await h.driver.kick(h.p.id); await until(() => h.invocations[0]?.commands.some(c => c.type === "prompt") ?? false);
  const abort = h.driver.abort(h.p.id, r.id);
  await until(() => h.invocations[0].commands.some(c => c.type === "abort"));
  expect(h.log.includes("restart")).toBe(false);
  h.rpcTimers.expire(5000); await abort; await h.driver.idle(h.p.id);
  expect(h.log.filter(s => ["abort", "kill", "restart", "ready"].includes(s))).toEqual(["abort", "kill", "restart", "ready"]);
  expect(h.commands).toEqual([]); expect(h.priorChanges()).toBe(true);
  await terminal(h.p.id, r.id, "已停止讨论，应用未更改");
});

for (const failure of ["restart nonzero", "readiness timeout"] as const) {
  test(`${failure} fails cancellation atomically without stash and the next run executes via ensure`, async () => {
    const h = await harness(); const real = await runtimeHarness();
    const r = await queue(h.p.id); const next = await queue(h.p.id, "chat");
    real.store.projects.set(h.p.id, h.p);
    real.docker.add(h.p, real.root);
    let starts = 0;
    h.setEnsure(async () => {
      if (++starts === 2) { real.setReady(true); }
      h.log.push("ensure"); await real.runtime.ensure(h.p.id, h.p.previewLabel);
    });
    h.configure(rpc => {
      if (starts !== 1) return;
      rpc.auto = false;
      rpc.cleanup = async () => {
        h.log.push("restart");
        if (failure === "restart nonzero") real.docker.restartExitCode = 1;
        else real.setReady(false);
        return real.runtime.restart(h.p.id, h.p.previewLabel);
      };
      // Teardown exceptions must not prevent the failed terminal transaction.
      const kill = rpc.kill.bind(rpc);
      rpc.kill = () => { kill(); rpc.close = () => { throw new Error("host handle teardown failed"); }; };
    });
    try {
      await h.driver.kick(h.p.id);
      await until(() => h.invocations[0]?.commands.some(c => c.type === "prompt") ?? false);
      await h.driver.abort(h.p.id, r.id); await h.driver.idle(h.p.id);
      await terminal(h.p.id, r.id, "停止时环境异常，应用可能没有完全停止，请稍后重试", "failed");
      expect(h.commands).toEqual([]); expect(h.errors).toEqual([]);
      expect(h.priorChanges()).toBe(true);
      expect((await store.run(h.p.id, next.id))?.status).toBe("succeeded");
      expect(h.log.filter(s => s === "restart")).toHaveLength(1);
      expect(starts).toBe(2); expect(h.invocations).toHaveLength(2);
      if (failure === "readiness timeout") {
        expect(real.probes).toHaveLength(122); // Initial ensure, 120 failed probes, next ensure.
        expect(real.now() - Date.parse(at)).toBe(60_000);
      }
    } finally { await real.cleanup(); }
  });
}

test("stop cancels an active check immediately and never starts repair or commit", async () => {
  const h = await harness(); const r = await queue(h.p.id); const checking = deferred<void>();
  let checkStopped = false;
  h.setHook(async (_container, argv, signal) => {
    if (argv[0] === "bun") {
      checking.resolve(); await new Promise<void>(resolve => signal!.addEventListener("abort", () => { checkStopped = true; h.log.push("check host killed"); resolve(); }, { once: true }));
      throw new Error("check interrupted");
    }
    return { exitCode: 0, output: "" };
  });
  await h.driver.kick(h.p.id); await checking.promise; await h.driver.abort(h.p.id, r.id); await h.driver.idle(h.p.id);
  expect(h.log.filter(s => ["check host killed", "restart", "ready", "git stash"].includes(s))).toEqual(["check host killed", "restart", "ready", "git stash"]);
  expect(checkStopped).toBe(true); expect(h.invocations[0].commands.filter(c => c.type === "prompt")).toHaveLength(1);
  expect(h.commands.some(c => c[1] === "commit")).toBe(false);
  await terminal(h.p.id, r.id, "已停止，应用已回到初始状态");
});

test("committing rejects cancellation, successful terminal publication occurs once after persisted version and message", async () => {
  const h = await harness(); const r = await queue(h.p.id); const committing = deferred<void>(); const release = deferred<void>();
  const reads: Promise<void>[] = [];
  h.events.subscribe(h.p.id, record => {
    if (record.event.kind === "version") reads.push((async () => {
      expect((await store.run(h.p.id, r.id))?.status).toBe("succeeded");
      expect(await db.select().from(schema.messages).where(eq(schema.messages.runId, r.id))).toHaveLength(1);
      const [p] = await db.select().from(schema.projects).where(eq(schema.projects.id, h.p.id)); expect(p.currentVersionId).toBe(record.event.kind === "version" ? record.event.versionId : null);
    })());
  });
  h.setHook(async (_container, argv) => {
    if (argv[1] === "commit") { committing.resolve(); await release.promise; }
    return { exitCode: 0, output: argv[1] === "rev-parse" ? "c".repeat(40) : "" };
  });
  await h.driver.kick(h.p.id); await committing.promise;
  await expect(h.driver.abort(h.p.id, r.id)).rejects.toMatchObject({ status: 409 }); release.resolve(); await h.driver.idle(h.p.id); await Promise.all(reads);
  expect(h.records.filter(e => e.kind === "version")).toHaveLength(1);
  expect(h.records.filter(e => e.kind === "status" && e.status === "succeeded")).toHaveLength(1);
  expect(h.commands.some(c => c[1] === "stash")).toBe(false);
});

test("terminal event-insert failure rolls back status, version, currentVersion, assistant and events with no publication; lane order survives", async () => {
  const p = await project(); const r = await queue(p.id); await store.claim(p.id, r.id, new Date(at));
  const events = new DurableEvents(store); const published: RunEvent[] = [];
  events.subscribe(p.id, row => published.push(row.event));
  await db.execute(sql.raw(`CREATE FUNCTION t12_fail_terminal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected terminal failure'; END $$`));
  await db.execute(sql.raw(`CREATE TRIGGER t12_fail_terminal BEFORE INSERT ON run_events FOR EACH ROW WHEN (NEW.project_id = '${p.id}' AND NEW.kind = 'version') EXECUTE FUNCTION t12_fail_terminal()`));
  const input = { runId: r.id, expected: "running" as const, status: "succeeded" as const, content: "success", now: new Date(at), version: { number: 1, commitSha: "a".repeat(40), summary: "one", screenshot: false } };
  try { await expect(events.finish(p.id, input)).rejects.toThrow(); }
  finally {
    await db.execute(sql.raw("DROP TRIGGER t12_fail_terminal ON run_events"));
    await db.execute(sql.raw("DROP FUNCTION t12_fail_terminal()"));
  }
  expect((await store.run(p.id, r.id))?.status).toBe("running");
  expect(await db.select().from(schema.versions).where(eq(schema.versions.projectId, p.id))).toEqual([]);
  const [savedProject] = await db.select().from(schema.projects).where(eq(schema.projects.id, p.id)); expect(savedProject.currentVersionId).toBeNull();
  expect(await db.select().from(schema.messages).where(eq(schema.messages.runId, r.id))).toEqual([]);
  expect(await store.backlog(p.id, 0)).toEqual([]); expect(published).toEqual([]);
  const before: RunEvent = { runId: r.id, seq: 1, at, kind: "text", delta: "before" };
  const append = events.append(p.id, [before]); const finish = events.finish(p.id, input);
  await Promise.all([append, finish]);
  expect(published.map(e => e.kind)).toEqual(["text", "version", "status"]);
  expect(published.map(e => e.seq)).toEqual([1, 2, 3]);
  expect((await store.backlog(p.id, 0)).map(r => r.event)).toEqual(published);
});

test("matching prompt_result plus later settlement is required; unrelated/early settled frames do not start checks", async () => {
  const h = await harness(); await queue(h.p.id); h.configure(rpc => { rpc.auto = false; });
  await h.driver.kick(h.p.id); await until(() => h.invocations[0]?.commands.some(c => c.type === "prompt") ?? false);
  const rpc = h.invocations[0]; rpc.emit({ type: "session_settled" }); rpc.emit({ type: "prompt_result", id: "other", status: "completed", sessionSettled: true }); rpc.finish(undefined, false);
  await Bun.sleep(5); expect(h.commands).toEqual([]);
  rpc.emit({ type: "session_settled" }); await h.driver.idle(h.p.id);
  expect(h.commands[0]).toEqual(["bun", "run", "check"]);
});

test("synthetic positive prompt and abort ACKs cannot replace matching result plus settlement", async () => {
  const rpc = new FakeRpc(); rpc.auto = false; rpc.abortSettles = false;
  const timers = new Timers(); const omp = new OmpRpc(rpc, () => {}, timers);
  await omp.open("build", new AbortController().signal);
  let promptDone = false; let abortDone = false;
  const prompt = omp.prompt("synthetic request").then(result => { promptDone = true; return result; });
  rpc.emit({ type: "response", command: "prompt", id: rpc.commands.at(-1)!.id, success: true });
  await Bun.sleep(1); expect(promptDone).toBe(false);
  const abort = omp.abort().then(() => { abortDone = true; });
  await Bun.sleep(1); expect(abortDone).toBe(false); expect(promptDone).toBe(false);
  rpc.status = "aborted"; rpc.finish(undefined, false);
  await Bun.sleep(1); expect(abortDone).toBe(false); expect(promptDone).toBe(false);
  rpc.emit({ type: "session_settled" });
  expect((await prompt).status).toBe("aborted"); await abort; await omp.close();
  expect(rpc.cleaned).toBe(false); expect(rpc.killed).toBe(false);
});

test("synthetic assistant message_start resets summary text while other roles preserve it", () => {
  const bodies: any[] = []; const mapper = new OmpEventMapper(body => bodies.push(body));
  const delta = (text: string) => mapper.receive({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
  delta("first");
  mapper.receive({ type: "message_start", message: { role: "user" } }); delta(" continued");
  expect(mapper.lastText).toBe("first continued");
  mapper.receive({ type: "message_start", message: { role: "assistant" } }); delta("second"); delta(" final");
  expect(mapper.lastText).toBe("second final");
  expect(bodies.map(e => e.delta)).toEqual(["first", " continued", "second", " final"]);
});

test("missing settled then EOF fails without checks, and prompt errors are persisted", async () => {
  for (const error of [false, true]) {
    const h = await harness(); const r = await queue(h.p.id);
    h.configure(rpc => { rpc.auto = false; rpc.onPrompt = frame => {
      rpc.emit({ type: "prompt_result", id: frame.id, status: error ? "error" : "completed", sessionSettled: error, error: { message: "provider failure" } });
      if (!error) rpc.close();
    }; });
    await h.driver.kick(h.p.id); await h.driver.idle(h.p.id);
    expect((await store.run(h.p.id, r.id))?.status).toBe("failed"); expect(h.commands).toEqual([]);
    expect(h.records.some(e => e.kind === "error")).toBe(true);
  }
});

test("open_session must succeed before prompting; authenticated kick/abort routes return scheduling and status errors", async () => {
  const h = await harness(); const r = await queue(h.p.id, "chat"); const release = deferred<void>();
  h.setEnsure(async () => { await release.promise; });
  const app = createManagerApp({ secret, webOrigin: origin, store, events: h.events, runtime: h.runtime as unknown as ProjectRuntime });
  registerRunRoutes(app, h.driver);
  const path = `/projects/${h.p.id}/kick`;
  expect((await app.request(path, { method: "POST", body: JSON.stringify({ previewLabel: h.p.previewLabel }) })).status).toBe(401);
  expect((await app.request(path, { method: "POST", headers: auth, body: JSON.stringify({ previewLabel: h.p.previewLabel }) })).status).toBe(200);
  await until(async () => (await store.run(h.p.id, r.id))?.status === "running");
  expect((await app.request(`/projects/${h.p.id}/runs/${r.id}/abort`, { method: "POST", headers: auth, body: "{}" })).status).toBe(200);
  release.resolve(); await h.driver.idle(h.p.id);
  await terminal(h.p.id, r.id, "已停止讨论，应用未更改");
});

// Fixture values are real redacted observations. The replay transport only
// rebinds command correlation IDs to this test's outgoing RPC commands; it does
// not manufacture missing recorded fields or claim unredacted token content.
for (const name of ["snake-build", "followup-build", "chat-readonly", "abort"]) {
  test(`small real-field replay: ${name} mapping, tool pairing and terminal order`, async () => {
    const raw = await Bun.file(new URL(`../../../fixtures/omp/${name}.ndjson`, import.meta.url)).text();
    const frames: Frame[] = raw.trim().split("\n").map(line => JSON.parse(line));
    const bodies: any[] = []; const mapper = new OmpEventMapper(body => bodies.push(body));
    for (const frame of frames) mapper.receive(frame);
    expect(frames[0].type).toBe("ready");
    expect(frames.find(f => f.command === "open_session")?.data.cancelled).toBe(false);
    expect(frames.at(-2)?.type).toBe("prompt_result"); expect(frames.at(-1)?.type).toBe("session_settled");
    expect(bodies.filter(e => e.kind === "text").length).toBeGreaterThan(0);
    expect(bodies.filter(e => e.kind === "thinking").length).toBeGreaterThan(0);
    for (const type of ["thinking_delta", "text_delta", "toolcall_delta"]) {
      expect(frames.filter(f => f.assistantMessageEvent?.type === type)).toHaveLength(2);
    }
    const starts = bodies.filter(e => e.kind === "tool" && e.phase === "start");
    const ends = bodies.filter(e => e.kind === "tool" && e.phase === "end");
    expect(ends.map(e => e.toolCallId).sort()).toEqual(starts.map(e => e.toolCallId).sort());
    const expectedTools: Record<string, string[]> = {
      "snake-build": ["bash", "edit", "eval", "read", "todo", "write"],
      "followup-build": ["bash", "write"], "chat-readonly": ["read"], "abort": ["bash", "write"],
    };
    expect(starts.map(e => e.name).sort()).toEqual(expectedTools[name]);
    expect(mapper.lastText).toContain("[WITHHELD_INCREMENTAL_CONTENT]");
    expect(raw.length).toBeLessThan(12_000); expect(frames.length).toBeLessThan(40);
    const h = await harness(); const r = await queue(h.p.id, name === "chat-readonly" ? "chat" : "build");
    h.configure(rpc => {
      rpc.auto = false;
      const send = rpc.send.bind(rpc);
      rpc.emit(frames[0]);
      rpc.send = line => {
        const command = JSON.parse(line);
        if (command.type === "open_session") {
          rpc.commands.push(command);
          rpc.emit({ ...frames.find(f => f.command === "open_session"), id: command.id });
        } else if (command.type === "prompt") {
          rpc.commands.push(command);
          for (const frame of frames.filter(f => !["ready", "response"].includes(f.type))) {
            if (name === "abort" && ["prompt_result", "session_settled"].includes(frame.type)) continue;
            rpc.emit(frame.type === "prompt_result" ? { ...frame, id: command.id } : frame);
          }
        } else if (name === "abort" && command.type === "abort") {
          rpc.commands.push(command);
          rpc.emit({ ...frames.find(f => f.command === "abort"), id: command.id });
          rpc.emit({ ...frames.find(f => f.type === "prompt_result"), id: rpc.commands.find(c => c.type === "prompt")!.id });
          rpc.emit(frames.at(-1)!);
        } else send(line);
      };
    });
    await h.driver.kick(h.p.id);
    if (name === "abort") {
      await until(() => h.invocations[0]?.commands.some(c => c.type === "prompt") ?? false);
      await h.driver.abort(h.p.id, r.id);
    }
    await h.driver.idle(h.p.id);
    expect(h.errors).toEqual([]);
    expect((await store.run(h.p.id, r.id))?.status).toBe(name === "abort" ? "cancelled" : "succeeded");
    if (name === "abort") await terminal(h.p.id, r.id, "已停止，应用已回到初始状态");
    if (name !== "chat-readonly" && name !== "abort") expect(h.records.some(e => e.kind === "version")).toBe(true);
    if (name === "abort") expect(frames.findIndex(f => f.command === "abort")).toBeLessThan(frames.findIndex(f => f.type === "prompt_result"));
  });
}

test("synthetic grep/glob titles are separate from real recorded tool coverage", () => {
  expect(toolTitle("grep", { pattern: "hello" })).toBe('搜索 "hello"');
  expect(toolTitle("glob", { pattern: "**/*.ts" })).toBe('查找文件 "**/*.ts"');
  expect(toolTitle("read", { path: "/workspace/src/a.ts" })).toBe("读取 src/a.ts");
  expect(toolTitle("write", { path: "/workspace/src/a.ts" })).toBe("写入 src/a.ts");
  expect(toolTitle("edit", { path: "/workspace/src/a.ts" })).toBe("编辑 src/a.ts");
  expect(toolTitle("bash", { command: "a".repeat(70) })).toBe("运行 " + "a".repeat(60));
  expect(toolTitle("eval")).toBe("执行代码片段"); expect(toolTitle("todo")).toBe("更新任务清单");
});


test("250ms durable batch merges adjacent visible deltas, streams only persisted records and flushes cancellation terminal", async () => {
  const h = await harness(); const r = await queue(h.p.id, "chat"); h.configure(rpc => { rpc.auto = false; });
  await h.driver.kick(h.p.id); await until(() => h.invocations[0]?.commands.some(c => c.type === "prompt") ?? false);
  const rpc = h.invocations[0];
  for (const delta of ["hello", " world"]) rpc.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
  for (const delta of ["one", "two"]) rpc.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta } });
  rpc.emit({ type: "tool_execution_start", toolCallId: "fake-grep", toolName: "grep", args: { pattern: "query" } });
  rpc.emit({ type: "tool_execution_end", toolCallId: "fake-grep", toolName: "grep", isError: false, result: { content: [{ type: "text", text: "found" }] } });
  await Bun.sleep(5);
  expect(await store.backlog(h.p.id, 0)).toEqual([]); expect(h.records).toEqual([]);
  h.timers.tick(); await until(async () => (await store.backlog(h.p.id, 0)).length === 6);
  expect(h.records.map(e => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(h.records[2]).toMatchObject({ kind: "text", delta: "hello world" });
  expect(h.records[3]).toMatchObject({ kind: "thinking", delta: "onetwo" });
  expect(h.records[4]).toMatchObject({ kind: "tool", phase: "start", title: '搜索 "query"' });
  expect(h.records[5]).toMatchObject({ kind: "tool", phase: "end", ok: true, summary: "found" });
  await h.driver.abort(h.p.id, r.id); await h.driver.idle(h.p.id);
  expect(h.records.at(-1)).toMatchObject({ seq: 7, status: "cancelled", detail: "已停止讨论，应用未更改" });
  expect(h.records).toEqual((await store.backlog(h.p.id, 0)).map(r => r.event));
});
