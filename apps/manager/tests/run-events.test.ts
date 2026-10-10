import { expect, test } from "bun:test";
import { OmpEventMapper } from "../src/run-events";
import type { Frame } from "../src/omp-rpc";
import type { PlanPhase } from "@min-atoms/protocol";

// Synthetic frames use the tagged v18.8.4 contracts in rpc-types.ts,
// task/types.ts and tui/overlays/session-observer-registry.ts.
function mapperHarness() {
  const bodies: any[] = [];
  const mapper = new OmpEventMapper(body => bodies.push(body));
  let id = 0;
  const todo = (phases: PlanPhase[], isError = false) => {
    const toolCallId = `todo-${++id}`;
    mapper.receive({ type: "tool_execution_start", toolCallId, toolName: "todo" });
    mapper.receive({ type: "tool_execution_end", toolCallId, toolName: "todo", isError,
      result: { content: [{ type: "text", text: "summary" }], details: { phases } } });
  };
  return { mapper, bodies, todo };
}

test("todo success maps a full five-status plan; errors and PM task/todo emit no tool steps", () => {
  const h = mapperHarness();
  const phases: PlanPhase[] = [{ name: "计划", tasks: [
    { content: "等待", status: "pending" }, { content: "进行", status: "in_progress" },
    { content: "完成", status: "completed" }, { content: "放弃", status: "abandoned" },
    { content: "阻塞", status: "blocked", blocker: "等待确认" },
  ] }];
  h.todo(phases);
  h.todo([], true);
  h.mapper.receive({ type: "tool_execution_start", toolCallId: "task", toolName: "task" });
  h.mapper.receive({ type: "tool_execution_end", toolCallId: "task", isError: false });
  expect(h.bodies).toEqual([{ kind: "plan", phases }]);
});

test("completed and abandoned tasks survive deletion/status changes in their original phase with locked true", () => {
  const h = mapperHarness();
  h.todo([{ name: "实现", tasks: [{ content: "完成", status: "completed" }, { content: "放弃", status: "abandoned" }] },
    { name: "检查", tasks: [{ content: "可调整", status: "pending" }] }]);
  const first = structuredClone(h.bodies[0]);
  h.todo([{ name: "实现", tasks: [] }, { name: "检查", tasks: [
    { content: "放弃", status: "completed" }, { content: "可调整", status: "in_progress" },
  ] }]);
  expect(h.bodies.at(-1)).toEqual({ kind: "plan", phases: [
    { name: "实现", tasks: [{ content: "完成", status: "completed", locked: true }, { content: "放弃", status: "abandoned", locked: true }] },
    { name: "检查", tasks: [{ content: "可调整", status: "in_progress" }] },
  ] });
  h.todo([{ name: "新阶段", tasks: [{ content: "完成", status: "pending" }] }]);
  expect(h.bodies.at(-1)).toEqual({ kind: "plan", phases: [
    { name: "新阶段", tasks: [] },
    { name: "实现", tasks: [{ content: "完成", status: "completed", locked: true }, { content: "放弃", status: "abandoned", locked: true }] },
  ] });
  h.todo([{ name: "实现", tasks: [{ content: "完成", status: "completed" }, { content: "放弃", status: "abandoned" }] }]);
  expect(h.bodies.at(-1).phases[0].tasks.every((task: any) => task.locked)).toBe(true);
  expect(h.bodies[0]).toEqual(first);
  const nextRun = mapperHarness(); nextRun.todo([]);
  expect(nextRun.bodies).toEqual([{ kind: "plan", phases: [] }]);
});

for (const [name, role, status] of [["designer", "designer", "completed"], ["engineer", "engineer", "failed"], ["scout", "engineer", "aborted"]]) {
  test(`${name} lifecycle maps ${role} role and ${status} outcome; only child tools are forwarded`, () => {
    const h = mapperHarness(); const id = `child-${name}`;
    const child = (event: Frame) => h.mapper.receive({ type: "subagent_event", payload: { id, event } });
    const lifecycle = (status: string) => h.mapper.receive({ type: "subagent_lifecycle", payload: {
      id, agent: name, agentSource: "user", description: "安排任务".repeat(30), status, index: 0,
    } });
    h.mapper.receive({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "PM 最终回复" } });
    lifecycle("started");
    child({ type: "message_start", message: { role: "assistant" } });
    child({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "旧消息" } });
    child({ type: "message_start", message: { role: "assistant" } });
    child({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "已完成界面\n" } });
    child({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "检查通过\n第三行" } });
    child({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "private thought" } });
    h.mapper.receive({ type: "subagent_progress", payload: { id, progress: { recentOutput: ["drop"] } } });
    child({ type: "tool_execution_start", toolCallId: "edit", toolName: "edit", args: { path: "/workspace/src/app.tsx" } });
    child({ type: "tool_execution_end", toolCallId: "edit", isError: false, result: { content: [{ type: "text", text: "updated" }] } });
    child({ type: "tool_execution_update", toolCallId: "edit", partialResult: { content: [] } });
    lifecycle(status);
    expect(h.bodies).toEqual([
      { kind: "text", delta: "PM 最终回复" },
      { kind: "agent", phase: "start", agent: { id, role }, label: "安排任务".repeat(15) },
      { kind: "tool", phase: "start", agent: { id, role }, toolCallId: "edit", name: "edit", title: "编辑 src/app.tsx" },
      { kind: "tool", phase: "end", agent: { id, role }, toolCallId: "edit", name: "edit", title: "编辑 src/app.tsx", ok: true, summary: "updated" },
      { kind: "agent", phase: "end", agent: { id, role }, label: "安排任务".repeat(15), ok: status === "completed", summary: "已完成界面\n检查通过" },
    ]);
    expect(h.mapper.lastText).toBe("PM 最终回复");
  });
}

test("child message_end supplies visible summary capped at 200; tool pairing is scoped by child id", () => {
  const h = mapperHarness();
  for (const id of ["a", "b"]) {
    h.mapper.receive({ type: "subagent_lifecycle", payload: { id, agent: id === "a" ? "designer" : "engineer", status: "started", description: "任务" } });
    h.mapper.receive({ type: "subagent_event", payload: { id, event: {
      type: "tool_execution_start", toolCallId: "shared", toolName: id === "a" ? "write" : "bash", args: { path: "x", command: "bun run check" },
    } } });
  }
  for (const id of ["b", "a"]) {
    h.mapper.receive({ type: "subagent_event", payload: { id, event: { type: "tool_execution_end", toolCallId: "shared", isError: id === "a" } } });
    h.mapper.receive({ type: "subagent_event", payload: { id, event: { type: "message_end", message: {
      role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "长".repeat(250) }],
    } } } });
    h.mapper.receive({ type: "subagent_lifecycle", payload: { id, agent: id === "a" ? "designer" : "engineer", status: "completed" } });
  }
  expect(h.bodies.filter(body => body.kind === "tool" && body.phase === "end").map(body => [body.name, body.agent.id, body.ok]))
    .toEqual([["bash", "b", true], ["write", "a", false]]);
  expect(h.bodies.filter(body => body.kind === "agent" && body.phase === "end").every(body => body.summary === "长".repeat(200))).toBe(true);
  expect(h.mapper.lastText).toBe("");
});
