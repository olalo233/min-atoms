import { posix } from "node:path";
import { PlanPhaseSchema, type RunEvent, type PlanPhase, type PlanTask, type AgentRef } from "@min-atoms/protocol";
import type { Frame } from "./omp-rpc";
import { DurableEvents, heartbeatTimers, type HeartbeatTimers } from "./events";

type EventBody = RunEvent extends infer E ? E extends RunEvent ? Omit<E, "runId" | "seq" | "at"> : never : never;
export function toolTitle(name: string, args: Frame = {}): string {
  const raw = typeof args.path === "string" ? args.path : "";
  const path = raw.startsWith("/") ? posix.relative("/workspace", posix.normalize(raw)) : posix.normalize(raw || ".");
  switch (name) {
    case "read": return `读取 ${path}`;
    case "write": return `写入 ${path}`;
    case "edit": return `编辑 ${path}`;
    case "bash": return `运行 ${String(args.command ?? "").slice(0, 60)}`;
    case "eval": return "执行代码片段";
    case "grep": return `搜索 "${args.pattern ?? ""}"`;
    case "glob": return `查找文件 "${args.pattern ?? ""}"`;
    case "todo": return "更新任务清单";
    default: return `使用工具 ${name}`;
  }
}

export class RunBuffer {
  private pending: RunEvent[] = [];
  private tail: Promise<unknown> = Promise.resolve();
  private failure?: unknown;
  private readonly stop: () => void;
  constructor(private readonly events: DurableEvents, private readonly projectId: string, private readonly runId: string,
    private seq: number, private readonly now: () => number, timers: HeartbeatTimers = heartbeatTimers) {
    this.stop = timers.every(() => { void this.flush().catch(() => {}); }, 250);
  }
  add(body: EventBody) {
    const last = this.pending.at(-1);
    if ((body.kind === "text" || body.kind === "thinking") && last?.kind === body.kind) {
      last.delta += body.delta;
    } else this.pending.push({ ...body, runId: this.runId, seq: ++this.seq, at: new Date(this.now()).toISOString() } as RunEvent);
  }
  flush(): Promise<unknown> {
    const batch = this.pending; this.pending = [];
    this.tail = this.tail.then(async () => {
      if (this.failure) throw this.failure;
      if (batch.length) await this.events.append(this.projectId, batch);
    }).catch(error => { this.failure = error; throw error; });
    void this.tail.catch(() => {});
    return this.tail;
  }
  async close() { this.stop(); await this.flush(); }
}

export class OmpEventMapper {
  lastText = "";
  private currentText = "";
  private readonly tools = new Map<string, { name: string; title: string }>();
  private readonly closedTasks = new Map<string, { phase: string; task: PlanTask }>();
  private readonly agents = new Map<string, { agent: AgentRef; label: string; currentText: string; lastText: string }>();
  constructor(private readonly add: (body: EventBody) => void) {}

  private plan(input: unknown) {
    const parsed = PlanPhaseSchema.array().safeParse(input);
    // Old redacted recordings have no details; never infer phases from text.
    if (!parsed.success) return;
    const phases: PlanPhase[] = parsed.data;
    for (const [content, closed] of this.closedTasks) {
      const current = phases.flatMap(phase => phase.tasks).find(task => task.content === content);
      if (current?.status === closed.task.status) {
        if (closed.task.locked) current.locked = true;
        continue;
      }
      for (const phase of phases) phase.tasks = phase.tasks.filter(task => task.content !== content);
      let original = phases.find(phase => phase.name === closed.phase);
      if (!original) { original = { name: closed.phase, tasks: [] }; phases.push(original); }
      closed.task = { ...closed.task, locked: true };
      original.tasks.push({ ...closed.task });
    }
    for (const phase of phases) for (const task of phase.tasks) {
      if ((task.status === "completed" || task.status === "abandoned") && !this.closedTasks.has(task.content)) {
        this.closedTasks.set(task.content, { phase: phase.name, task: { ...task } });
      }
    }
    this.add({ kind: "plan", phases });
  }

  private subagent(frame: Frame) {
    const payload = frame.payload;
    if (typeof payload?.id !== "string") return;
    let child = this.agents.get(payload.id);
    if (frame.type === "subagent_lifecycle") {
      if (!["started", "completed", "failed", "aborted"].includes(payload.status)) return;
      const agent: AgentRef = { id: payload.id, role: payload.agent === "designer" ? "designer" : "engineer" };
      const label = typeof payload.description === "string" ? payload.description.slice(0, 60) : child?.label ?? "";
      if (payload.status === "started") {
        this.agents.set(payload.id, { agent, label, currentText: "", lastText: "" });
        this.add({ kind: "agent", phase: "start", agent, label });
      } else {
        this.add({ kind: "agent", phase: "end", agent, label, ok: payload.status === "completed",
          summary: child?.lastText.split("\n").slice(0, 2).join("\n").slice(0, 200) ?? "" });
        this.agents.delete(payload.id);
      }
      return;
    }
    const event = payload.event;
    if (!event || typeof event.type !== "string") return;
    if (!child) {
      child = { agent: { id: payload.id, role: "engineer" }, label: "", currentText: "", lastText: "" };
      this.agents.set(payload.id, child);
    }
    if (event.type === "message_start" && event.message?.role === "assistant") child.currentText = "";
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta"
      && typeof event.assistantMessageEvent.delta === "string") {
      child.currentText = (child.currentText + event.assistantMessageEvent.delta).slice(0, 200);
      child.lastText = child.currentText;
    }
    if (event.type === "message_end" && event.message?.role === "assistant" && Array.isArray(event.message.content)) {
      const text = event.message.content.filter((part: Frame) => part.type === "text" && typeof part.text === "string")
        .map((part: Frame) => part.text).join("\n");
      if (text) child.lastText = text.slice(0, 200);
    }
    this.tool(event, child.agent);
  }

  private tool(frame: Frame, agent?: AgentRef) {
    const key = JSON.stringify([agent?.id ?? "pm", frame.toolCallId]);
    if (frame.type === "tool_execution_start") {
      if (typeof frame.toolCallId !== "string" || typeof frame.toolName !== "string") throw new Error("Invalid tool start");
      const tool = { name: frame.toolName, title: toolTitle(frame.toolName, frame.args) };
      this.tools.set(key, tool);
      if (!agent && ["todo", "task"].includes(tool.name)) return;
      this.add({ kind: "tool", phase: "start", toolCallId: frame.toolCallId, ...tool, ...(agent ? { agent } : {}) });
    } else if (frame.type === "tool_execution_end") {
      const tool = this.tools.get(key);
      if (!tool) throw new Error("Tool end without start");
      this.tools.delete(key);
      if (!agent && tool.name === "todo") {
        if (frame.isError === false) this.plan(frame.result?.details?.phases);
        return;
      }
      if (!agent && tool.name === "task") return;
      const summary = Array.isArray(frame.result?.content) ? frame.result.content
        .filter((item: Frame) => item.type === "text" && typeof item.text === "string")
        .map((item: Frame) => item.text).join("\n").split("\n").slice(0, 10).join("\n").slice(0, 2000) : undefined;
      this.add({ kind: "tool", phase: "end", toolCallId: frame.toolCallId, ...tool, ...(agent ? { agent } : {}),
        ok: frame.isError === false, ...(summary ? { summary } : {}) });
    }
  }

  receive(frame: Frame) {
    if (frame.type === "subagent_lifecycle" || frame.type === "subagent_event") { this.subagent(frame); return; }
    if (frame.type.startsWith("subagent_")) return;
    if (frame.type === "message_start" && frame.message?.role === "assistant") this.currentText = "";
    if (frame.type === "message_update") {
      const event = frame.assistantMessageEvent;
      if (event?.type === "text_delta" && typeof event.delta === "string") {
        this.currentText += event.delta;
        this.lastText = this.currentText;
        this.add({ kind: "text", delta: event.delta });
      } else if (event?.type === "thinking_delta" && typeof event.delta === "string") {
        this.add({ kind: "thinking", delta: event.delta });
      }
    }
    this.tool(frame);
  }
}
