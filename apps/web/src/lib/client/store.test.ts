import { describe, expect, it } from "bun:test";
import { ProjectDetailSchema, RunEventSchema } from "@min-atoms/protocol";

import { createMockSource } from "./mock";
import {
  WorkbenchStore,
  buildTimeline,
  cancelledNote,
  findActiveRun,
  hasBlockingRun,
  nextVersionNumber,
  runDurationText,
  statusLineText,
} from "./store";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const RUN_OK = "22222222-2222-4222-8222-222222222222";
const RUN_FAILED = "55555555-5555-4555-8555-555555555555";
const VERSION_1 = "33333333-3333-4333-8333-333333333333";
const T0 = Date.parse("2026-10-08T12:00:00.000Z");
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

async function loadScenario(scenario: string): Promise<WorkbenchStore> {
  const source = createMockSource(PROJECT_ID, scenario);
  const store = new WorkbenchStore(PROJECT_ID);
  store.loadDetail(await source.loadProject());
  return store;
}

describe("mock scenarios", () => {
  it.each(["live", "running", "succeeded", "failed", "failed-restart", "cancelled", "queued", "env-down", "long", "build", "building", "stress"])(
    "scenario %s produces a valid ProjectDetail",
    async (scenario) => {
      const source = createMockSource(PROJECT_ID, scenario);
      const detail = await source.loadProject();
      expect(ProjectDetailSchema.safeParse(detail).success).toBe(true);
    },
  );

  it("building scenario freezes mid-run on a running step after a failed check", async () => {
    const store = await loadScenario("building");
    const detail = await createMockSource(PROJECT_ID, "building").loadProject();
    for (const event of detail.runs[0].events ?? []) {
      expect(RunEventSchema.safeParse(event).success).toBe(true);
    }
    const run = Object.values(store.getSnapshot().runs)[0];
    expect(run.phase).toBe("running");
    expect(run.steps.length).toBeGreaterThan(6);
    expect(run.steps.at(-1)?.status).toBe("running");
    expect(run.steps.some((step) => step.status === "failed")).toBe(true);
    expect(statusLineText(run, true)).toBe("正在运行 bun run check…");
  });

  it("preview URL is the local mock page, never a live host", async () => {
    const source = createMockSource(PROJECT_ID, "live");
    expect(await source.getPreviewUrl()).toBe("/p/mock-preview");
  });
});

describe("WorkbenchStore event application", () => {
  it("accumulates text, tracks tool steps, and dedupes by event id", async () => {
    const store = await loadScenario("running");
    const detail = await createMockSource(PROJECT_ID, "running").loadProject();
    const remaining = detail.runs[0].events?.length ?? 0;
    expect(remaining).toBeGreaterThan(0);

    const source = createMockSource(PROJECT_ID, "running");
    const events: { id: number; event: Parameters<WorkbenchStore["applyEvent"]>[1] }[] = [];
    source.subscribe(detail.lastEventId, (id, event) => events.push({ id, event }));
    await new Promise((resolve) => setTimeout(resolve, 5000));
    for (const { id, event } of events) store.applyEvent(id, event);
    // Replay the first event again: it must be dropped as a duplicate.
    if (events[0]) store.applyEvent(events[0].id, events[0].event);

    const run = store.getSnapshot().runs[RUN_OK];
    expect(run.phase).toBe("succeeded");
    expect(run.version?.number).toBe(1);
    expect(run.steps.every((step) => step.status === "done")).toBe(true);
    expect(store.getSnapshot().currentVersionId).toBe(VERSION_1);
  }, 15000);

  it("takes finished-run body text from the assistant message", async () => {
    const store = await loadScenario("succeeded");
    const timeline = buildTimeline(store.getSnapshot());
    const runItem = timeline.find((item) => item.type === "run");
    expect(runItem?.type).toBe("run");
    if (runItem?.type === "run") {
      expect(runItem.finalText).toContain("完成了");
    }
  });

  it("keeps queued runs behind their user message with the queue status line", async () => {
    const store = await loadScenario("queued");
    const state = store.getSnapshot();
    const timeline = buildTimeline(state);
    expect(timeline.map((item) => item.type)).toEqual(["user", "run", "user", "run"]);
    const queuedRun = timeline[3];
    if (queuedRun.type !== "run") throw new Error("expected run item");
    expect(statusLineText(queuedRun.run, true)).toBe("排队中，前一个任务完成后开始");
    expect(findActiveRun(state)?.id).toBe(RUN_OK);
    expect(hasBlockingRun(state)).toBe(true);
  });

  it("shows the environment-down queue copy when the VM is off", async () => {
    const store = await loadScenario("env-down");
    const state = { ...store.getSnapshot(), vmUp: false };
    const timeline = buildTimeline(state);
    const runItem = timeline.find((item) => item.type === "run");
    if (runItem?.type !== "run") throw new Error("expected run item");
    expect(statusLineText(runItem.run, false)).toBe("演示环境未启动，启动后自动开始");
  });

  it("derives the cancelled note from the version history", async () => {
    const store = await loadScenario("cancelled");
    const state = store.getSnapshot();
    const timeline = buildTimeline(state);
    const cancelled = timeline.find((item) => item.type === "run" && item.run.phase === "cancelled");
    if (cancelled?.type !== "run") throw new Error("expected cancelled run");
    expect(cancelledNote(state, cancelled.run)).toBe("已停止，应用已回到版本 1");
  });

  it("records optimistic drafts, confirms them into real messages and runs", async () => {
    const store = await loadScenario("succeeded");
    const source = createMockSource(PROJECT_ID, "succeeded");
    const tempId = store.addDraft("加一个分类筛选", "build");
    expect(buildTimeline(store.getSnapshot()).at(-1)?.type).toBe("draft");
    const { message, run } = await source.sendMessage("加一个分类筛选", "build");
    store.confirmDraft(tempId, message, run);
    const state = store.getSnapshot();
    expect(state.drafts).toHaveLength(0);
    const timeline = buildTimeline(state);
    const lastRun = timeline.at(-1);
    if (lastRun?.type !== "run") throw new Error("expected run after the new user message");
    expect(statusLineText(lastRun.run, true)).toContain("排队中");
  });

  it("applies a restore as a note message plus a new current version", async () => {
    const store = await loadScenario("succeeded");
    const source = createMockSource(PROJECT_ID, "succeeded");
    const created = await source.restoreVersion(VERSION_1);
    expect(created.number).toBe(2);
    store.applyRestore(created, 1);
    const state = store.getSnapshot();
    expect(state.currentVersionId).toBe(created.id);
    const note = state.messages.at(-1);
    expect(note?.content).toBe("已恢复到版本 1");
    expect(note?.versionId).toBe(created.id);
  });

  it("validates the shared fixture against the protocol schema", async () => {
    const { default: sample } = await import("../../../../../fixtures/events/sample-run.json");
    for (const event of sample) {
      expect(RunEventSchema.safeParse(event).success).toBe(true);
    }
  });

  it("computes the next version number for the restore dialog", async () => {
    const store = await loadScenario("long");
    expect(nextVersionNumber(store.getSnapshot())).toBe(4);
  });
});

describe("run timing", () => {
  const messageDto = (id: string, seq: number, createdAt: string) => ({
    id,
    seq,
    role: "user" as const,
    mode: "build" as const,
    content: "做点什么",
    runId: null,
    versionId: null,
    createdAt,
  });

  it("anchors the rollback version at finish time for a run queued before v1", () => {
    // Run created before v1 existed, started after v1 was committed, then
    // cancelled. History filters status events, so the anchor must come from
    // the run row's finishedAt, not createdAt.
    const runId = "99999999-9999-4999-8999-999999999999";
    const user = messageDto("88888888-8888-4888-8888-888888888888", 1, at(0));
    const store = new WorkbenchStore(PROJECT_ID);
    store.loadDetail({
      id: PROJECT_ID,
      name: "t",
      previewLabel: "ma-test",
      currentVersionId: VERSION_1,
      createdAt: at(0),
      updatedAt: at(30_000),
      messages: [user],
      runs: [
        {
          id: runId,
          projectId: PROJECT_ID,
          userMessageId: user.id,
          mode: "build",
          status: "cancelled",
          error: null,
          createdAt: at(0),
          startedAt: at(20_000),
          finishedAt: at(30_000),
          events: [],
        },
      ],
      versions: [
        {
          id: VERSION_1,
          projectId: PROJECT_ID,
          number: 1,
          commitSha: "0".repeat(40),
          summary: "v1",
          runId: RUN_OK,
          screenshot: false,
          createdAt: at(10_000),
        },
      ],
      lastEventId: 0,
    });

    const run = store.getSnapshot().runs[runId];
    expect(cancelledNote(store.getSnapshot(), run)).toBe("已停止，应用已回到版本 1");
    // Duration excludes the queue wait: start->finish, not created->finish.
    expect(runDurationText(run)).toBe("10 秒");
  });

  it("infers start/finish timing from streamed status events", () => {
    const runId = "99999999-9999-4999-8999-999999999999";
    const store = new WorkbenchStore(PROJECT_ID);
    store.loadDetail({
      id: PROJECT_ID,
      name: "t",
      previewLabel: "ma-test",
      currentVersionId: VERSION_1,
      createdAt: at(0),
      updatedAt: at(30_000),
      messages: [],
      runs: [],
      versions: [
        {
          id: VERSION_1,
          projectId: PROJECT_ID,
          number: 1,
          commitSha: "0".repeat(40),
          summary: "v1",
          runId: RUN_OK,
          screenshot: false,
          createdAt: at(10_000),
        },
      ],
      lastEventId: 0,
    });

    store.applyEvent(1, { runId, seq: 1, at: at(20_000), kind: "status", status: "running" });
    store.applyEvent(2, { runId, seq: 2, at: at(30_000), kind: "status", status: "cancelled" });

    const run = store.getSnapshot().runs[runId];
    expect(run.startedAt).toBe(at(20_000));
    expect(run.finishedAt).toBe(at(30_000));
    expect(runDurationText(run)).toBe("10 秒");
    expect(cancelledNote(store.getSnapshot(), run)).toBe("已停止，应用已回到版本 1");
  });
});

describe("MockSource stopRun", () => {
  const waitFor = async (predicate: () => boolean, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("waitFor timed out");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  it("suppresses the cancelled run's remaining events while later runs continue", async () => {
    const source = createMockSource(PROJECT_ID, "live");
    const events: { id: number; event: Parameters<WorkbenchStore["applyEvent"]>[1] }[] = [];
    source.subscribe(0, (id, event) => events.push({ id, event }));

    // Wait until the first run's version event has been emitted so the mock
    // tracks v1 as the current version.
    await waitFor(() => events.some(({ event }) => event.kind === "version"), 15_000);
    await source.stopRun(RUN_OK);

    const cancelIndex = events.findIndex(
      ({ event }) => event.runId === RUN_OK && event.kind === "status" && event.status === "cancelled",
    );
    expect(cancelIndex).toBeGreaterThan(-1);
    const cancelled = events[cancelIndex].event;
    if (cancelled.kind !== "status") throw new Error("expected status event");
    // The version emitted before the stop is reported as the rollback target.
    expect(cancelled.detail).toBe("已停止，应用已回到版本 1");

    // The next queued run still streams afterwards.
    await waitFor(() => events.some(({ event }) => event.runId === RUN_FAILED), 15_000);
    const postCancel = events.slice(cancelIndex + 1).filter(({ event }) => event.runId === RUN_OK);
    expect(postCancel).toHaveLength(0);
  }, 40_000);
});
