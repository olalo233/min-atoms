import { posix } from "node:path";
import type { RunEvent } from "@min-atoms/protocol";
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
  constructor(private readonly add: (body: EventBody) => void) {}
  receive(frame: Frame) {
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
    if (frame.type === "tool_execution_start") {
      if (typeof frame.toolCallId !== "string" || typeof frame.toolName !== "string") throw new Error("Invalid tool start");
      const tool = { name: frame.toolName, title: toolTitle(frame.toolName, frame.args) };
      this.tools.set(frame.toolCallId, tool);
      this.add({ kind: "tool", phase: "start", toolCallId: frame.toolCallId, ...tool });
    } else if (frame.type === "tool_execution_end") {
      const tool = this.tools.get(frame.toolCallId);
      if (!tool) throw new Error("Tool end without start");
      this.tools.delete(frame.toolCallId);
      const summary = Array.isArray(frame.result?.content) ? frame.result.content
        .filter((item: Frame) => item.type === "text" && typeof item.text === "string")
        .map((item: Frame) => item.text).join("\n").split("\n").slice(0, 10).join("\n").slice(0, 2000) : undefined;
      this.add({ kind: "tool", phase: "end", toolCallId: frame.toolCallId, ...tool,
        ok: frame.isError === false, ...(summary ? { summary } : {}) });
    }
  }
}
