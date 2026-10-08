import type { MessageDTO, ProjectDetail, RunDTO, RunEvent, VersionDTO } from "@min-atoms/protocol";

import type { RunMode, WorkbenchSource } from "./source";
// Shared demo event stream written for the workbench (T10). Typed via the
// protocol RunEvent so drift between fixture and schema surfaces here.
import sampleRunJson from "../../../../../fixtures/events/sample-run.json";

const sampleEvents = sampleRunJson as RunEvent[];

const RUN_OK = "22222222-2222-4222-8222-222222222222";
const RUN_FAILED = "55555555-5555-4555-8555-555555555555";
const RUN_CANCELLED = "66666666-6666-4666-8666-666666666666";
const RUN_ENV_FAIL = "77777777-7777-4777-8777-777777777777";
const VERSION_1 = "33333333-3333-4333-8333-333333333333";

const messageId = (n: number) => `aaaa0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const versionId = (n: number) => `bbbb0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const runId = (n: number) => `cccc0000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const T0 = Date.parse("2026-10-08T12:00:00.000Z");
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

const eventsByRun = new Map<string, RunEvent[]>();
for (const event of sampleEvents) {
  const list = eventsByRun.get(event.runId) ?? [];
  list.push(event);
  eventsByRun.set(event.runId, list);
}
const fixtureEvents = (id: string): RunEvent[] => eventsByRun.get(id) ?? [];

/** History rule from architecture §10: finished runs replay without text. */
const historyEvents = (id: string): RunEvent[] =>
  fixtureEvents(id).filter((event) => event.kind === "tool" || event.kind === "version" || event.kind === "error");

const USER_MESSAGES = {
  m1: "做一个食谱应用：可以搜索食谱，并收藏喜欢的。",
  m2: "再加一个按分类筛选的功能。",
  m3: "把首页的排版再紧凑一点。",
  m4: "继续刚才的修改。",
};

const ASSISTANT_OK = `完成了！我搭好了一个食谱应用：

- 顶部可以**按名称搜索**食谱
- 每张卡片可以收藏，收藏保存在 \`SQLite\` 里
- 刷新页面后收藏不会丢

入口在 \`src/App.tsx\`，数据结构大致是：

\`\`\`ts
interface Recipe {
  id: number;
  title: string;
  favorite: boolean;
}
\`\`\`

可以继续告诉我接下来想加什么。`;

function userMessage(seq: number, content: string, createdAt: string, mode: RunMode = "build"): MessageDTO {
  return { id: messageId(seq), seq, role: "user", mode, content, runId: null, versionId: null, createdAt };
}

function assistantMessage(seq: number, content: string, createdAt: string, run: string | null, version: string | null = null): MessageDTO {
  return { id: messageId(seq), seq, role: "assistant", mode: "build", content, runId: run, versionId: version, createdAt };
}

function runDto(
  id: string,
  projectId: string,
  userMessage: MessageDTO,
  status: RunDTO["status"],
  createdAt: string,
  events: RunEvent[] = [],
  error: string | null = null,
  mode: RunMode = "build",
): RunDTO {
  return {
    id,
    projectId,
    userMessageId: userMessage.id,
    mode,
    status,
    error,
    createdAt,
    startedAt: status === "queued" ? null : createdAt,
    finishedAt: status === "succeeded" || status === "failed" || status === "cancelled" ? createdAt : null,
    events,
  };
}

const versionOne = (projectId: string): VersionDTO => ({
  id: VERSION_1,
  projectId,
  number: 1,
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  summary: "添加食谱列表",
  runId: RUN_OK,
  screenshot: false,
  createdAt: at(10_000),
});

interface ScenarioData {
  detail: ProjectDetail;
  /** Events replayed over the mock stream after subscription. */
  stream: RunEvent[];
  vmUp: boolean;
}

function buildScenario(projectId: string, scenario: string): ScenarioData {
  const m1 = userMessage(1, USER_MESSAGES.m1, at(0));
  const m2 = userMessage(3, USER_MESSAGES.m2, at(60_000));
  const m3 = userMessage(5, USER_MESSAGES.m3, at(120_000));
  const m4 = userMessage(7, USER_MESSAGES.m4, at(180_000));
  const a1 = assistantMessage(2, ASSISTANT_OK, at(11_000), RUN_OK);
  const okRunDone = () => runDto(RUN_OK, projectId, m1, "succeeded", at(0), historyEvents(RUN_OK));
  const base = {
    id: projectId,
    name: "食谱收藏夹",
    previewLabel: "ma-mockdemo",
    createdAt: at(0),
    updatedAt: at(0),
    lastEventId: 0,
  };

  switch (scenario) {
    case "running": {
      // Run 1 mid-flight; the remaining fixture events keep streaming in.
      const delivered = fixtureEvents(RUN_OK).slice(0, 7);
      return {
        detail: {
          ...base,
          currentVersionId: null,
          messages: [m1],
          runs: [runDto(RUN_OK, projectId, m1, "running", at(0), delivered)],
          versions: [],
          lastEventId: 7,
        },
        stream: fixtureEvents(RUN_OK).slice(7),
        vmUp: true,
      };
    }
    case "succeeded":
      return {
        detail: {
          ...base,
          currentVersionId: VERSION_1,
          messages: [m1, a1],
          runs: [okRunDone()],
          versions: [versionOne(projectId)],
          lastEventId: fixtureEvents(RUN_OK).length,
        },
        stream: [],
        vmUp: true,
      };
    case "failed":
      return {
        detail: {
          ...base,
          currentVersionId: VERSION_1,
          messages: [m1, a1, m2],
          runs: [
            okRunDone(),
            runDto(RUN_FAILED, projectId, m2, "failed", at(60_000), historyEvents(RUN_FAILED), "Type check failed: missing property in recipe form."),
          ],
          versions: [versionOne(projectId)],
          lastEventId: 20,
        },
        stream: [],
        vmUp: true,
      };
    case "failed-restart":
      return {
        detail: {
          ...base,
          currentVersionId: VERSION_1,
          messages: [m1, a1, m4],
          runs: [okRunDone(), runDto(RUN_ENV_FAIL, projectId, m4, "failed", at(180_000), historyEvents(RUN_ENV_FAIL), "环境重启")],
          versions: [versionOne(projectId)],
          lastEventId: 28,
        },
        stream: [],
        vmUp: true,
      };
    case "cancelled":
      return {
        detail: {
          ...base,
          currentVersionId: VERSION_1,
          messages: [m1, a1, m3],
          runs: [okRunDone(), runDto(RUN_CANCELLED, projectId, m3, "cancelled", at(120_000), historyEvents(RUN_CANCELLED))],
          versions: [versionOne(projectId)],
          lastEventId: 24,
        },
        stream: [],
        vmUp: true,
      };
    case "queued":
      return {
        detail: {
          ...base,
          currentVersionId: null,
          messages: [m1, m2],
          runs: [
            runDto(RUN_OK, projectId, m1, "running", at(0), fixtureEvents(RUN_OK).slice(0, 7)),
            runDto(RUN_FAILED, projectId, m2, "queued", at(60_000)),
          ],
          versions: [],
          lastEventId: 7,
        },
        stream: [],
        vmUp: true,
      };
    case "env-down":
      return {
        detail: {
          ...base,
          currentVersionId: null,
          messages: [m1],
          runs: [runDto(RUN_OK, projectId, m1, "queued", at(0))],
          versions: [],
          lastEventId: 0,
        },
        stream: [],
        vmUp: false,
      };
    case "long": {
      const messages: MessageDTO[] = [m1, a1];
      const runs: RunDTO[] = [okRunDone()];
      const versions: VersionDTO[] = [versionOne(projectId)];
      let seq = 3;
      const notes = [
        "这一轮我把列表拆成了独立组件，后续加动画会更方便。",
        "搜索改成了大小写不敏感，中文按整串匹配。",
        "收藏按钮加了按下反馈，点错可以马上取消。",
        "卡片间距收紧了，窄屏下一屏能多看两行。",
      ];
      for (let i = 0; i < 12; i += 1) {
        const offset = 300_000 + i * 120_000;
        const isBuild = i === 3 || i === 8;
        const mode: RunMode = isBuild ? "build" : "chat";
        const user = userMessage(seq, `第 ${i + 2} 轮：${notes[i % notes.length]}`, at(offset), mode);
        seq += 1;
        const rid = runId(i + 2);
        let events: RunEvent[] = [];
        if (isBuild) {
          const versionNumber = versions.length + 1;
          const version: VersionDTO = {
            id: versionId(versionNumber),
            projectId,
            number: versionNumber,
            commitSha: "abcdef0123456789abcdef0123456789abcdef01",
            summary: versionNumber === 2 ? "收紧列表排版" : "加入收藏筛选",
            runId: rid,
            screenshot: false,
            createdAt: at(offset + 60_000),
          };
          versions.push(version);
          events = [
            { runId: rid, seq: 1, at: at(offset + 60_000), kind: "version", versionId: version.id, number: version.number, commitSha: version.commitSha, summary: version.summary },
          ];
        }
        const body = [
          notes[i % notes.length],
          "",
          `另外顺手处理了这些：`,
          `- 保持了现有的交互不变`,
          `- **数据仍然保存在数据库里**，刷新后还在`,
          `- 相关代码在 \`src/App.tsx\``,
          "",
          "如果还有想调整的地方，直接继续说就行。",
        ].join("\n");
        messages.push(user);
        messages.push(assistantMessage(seq, body, at(offset + 61_000), rid));
        seq += 1;
        runs.push(runDto(rid, projectId, user, "succeeded", at(offset), events, null, mode));
      }
      const last = versions[versions.length - 1];
      return {
        detail: {
          ...base,
          currentVersionId: last.id,
          messages,
          runs,
          versions,
          lastEventId: 200,
          updatedAt: at(300_000 + 12 * 120_000),
        },
        stream: [],
        vmUp: true,
      };
    }
    case "live":
    default:
      // Full replay: four queued runs whose fixture events stream in live.
      return {
        detail: {
          ...base,
          currentVersionId: null,
          messages: [m1, m2, m3, m4],
          runs: [
            runDto(RUN_OK, projectId, m1, "queued", at(0)),
            runDto(RUN_FAILED, projectId, m2, "queued", at(60_000)),
            runDto(RUN_CANCELLED, projectId, m3, "queued", at(120_000)),
            runDto(RUN_ENV_FAIL, projectId, m4, "queued", at(180_000)),
          ],
          versions: [],
          lastEventId: 0,
        },
        stream: [...sampleEvents],
        vmUp: true,
      };
  }
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class MockSource implements WorkbenchSource {
  private readonly detail: ProjectDetail;
  private readonly plan: { event: RunEvent; delayMs: number }[];
  private readonly vmUp: boolean;
  private readonly versions: VersionDTO[];
  private listeners = new Set<(id: number, event: RunEvent) => void>();
  private timers: ReturnType<typeof setTimeout>[] = [];
  private nextEventId: number;
  private messageSeq: number;
  /** First not-yet-fired index into plan; survives resubscribe (StrictMode). */
  private planCursor = 0;
  /** Runs stopped via stopRun: their preplanned events are suppressed. */
  private readonly cancelledRuns = new Set<string>();
  /** Runs whose terminal status already fired; stopRun is a no-op for them. */
  private readonly finishedRuns = new Set<string>();

  constructor(projectId: string, scenario: string) {
    const data = buildScenario(projectId, scenario);
    this.detail = data.detail;
    this.vmUp = data.vmUp;
    this.versions = [...data.detail.versions];
    this.nextEventId = data.detail.lastEventId;
    this.messageSeq = data.detail.messages.reduce((max, m) => Math.max(max, m.seq), 0);

    // Replay timing follows the fixture's own `at` deltas, compressed.
    this.plan = [];
    let previousAt: number | null = null;
    for (const event of data.stream) {
      const atMs = Date.parse(event.at);
      const delta = previousAt === null ? 500 : atMs - previousAt;
      previousAt = atMs;
      this.plan.push({ event, delayMs: Math.min(600, Math.max(150, delta)) });
    }
  }

  async loadProject(): Promise<ProjectDetail> {
    await delay(350);
    return this.detail;
  }

  subscribe(_after: number, onEvent: (id: number, event: RunEvent) => void): () => void {
    this.listeners.add(onEvent);
    let elapsed = 0;
    for (let index = this.planCursor; index < this.plan.length; index += 1) {
      const { event, delayMs } = this.plan[index];
      elapsed += delayMs;
      this.timers.push(
        setTimeout(() => {
          this.planCursor = Math.max(this.planCursor, index + 1);
          // A cancelled run produces no further output; later queued runs are
          // unaffected because suppression is scoped to the run id.
          if (this.cancelledRuns.has(event.runId)) return;
          this.nextEventId += 1;
          if (event.kind === "version" && !this.versions.some((v) => v.id === event.versionId)) {
            this.versions.push({
              id: event.versionId,
              projectId: this.detail.id,
              number: event.number,
              commitSha: event.commitSha,
              summary: event.summary,
              runId: event.runId,
              screenshot: false,
              createdAt: event.at,
            });
          }
          if (event.kind === "status" && (event.status === "succeeded" || event.status === "failed" || event.status === "cancelled")) {
            this.finishedRuns.add(event.runId);
          }
          for (const listener of this.listeners) listener(this.nextEventId, event);
        }, elapsed),
      );
    }
    return () => {
      this.listeners.delete(onEvent);
      for (const timer of this.timers) clearTimeout(timer);
      this.timers = [];
    };
  }

  async getVmUp(): Promise<boolean> {
    return this.vmUp;
  }

  async ensure(): Promise<unknown> {
    await delay(1500);
    return {};
  }

  async getPreviewUrl(): Promise<string> {
    return "/p/mock-preview";
  }

  async sendMessage(content: string, mode: RunMode): Promise<{ message: MessageDTO; run: RunDTO }> {
    await delay(250);
    const now = new Date().toISOString();
    this.messageSeq += 1;
    const message: MessageDTO = {
      id: crypto.randomUUID(),
      seq: this.messageSeq,
      role: "user",
      mode,
      content,
      runId: null,
      versionId: null,
      createdAt: now,
    };
    const run: RunDTO = {
      id: crypto.randomUUID(),
      projectId: this.detail.id,
      userMessageId: message.id,
      mode,
      status: "queued",
      error: null,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
    };
    return { message, run };
  }

  async stopRun(targetRunId: string): Promise<unknown> {
    await delay(500);
    this.cancelledRuns.add(targetRunId);
    if (this.finishedRuns.has(targetRunId)) return {};
    this.finishedRuns.add(targetRunId);
    const current = this.versions.reduce((max, v) => Math.max(max, v.number), 0);
    this.nextEventId += 1;
    const event: RunEvent = {
      runId: targetRunId,
      seq: 900,
      at: new Date().toISOString(),
      kind: "status",
      status: "cancelled",
      detail: current > 0 ? `已停止，应用已回到版本 ${current}` : "已停止",
    };
    for (const listener of this.listeners) listener(this.nextEventId, event);
    return {};
  }

  async restoreVersion(targetVersionId: string): Promise<VersionDTO> {
    await delay(600);
    const target = this.versions.find((v) => v.id === targetVersionId);
    const number = this.versions.reduce((max, v) => Math.max(max, v.number), 0) + 1;
    const version: VersionDTO = {
      id: crypto.randomUUID(),
      projectId: this.detail.id,
      number,
      commitSha: "f".repeat(40),
      summary: `恢复到版本 ${target?.number ?? "?"}`,
      runId: null,
      screenshot: false,
      createdAt: new Date().toISOString(),
    };
    this.versions.push(version);
    return version;
  }

  async deleteProject(): Promise<unknown> {
    await delay(300);
    return {};
  }
}

/**
 * Mock workbench data for NEXT_PUBLIC_MOCK_STREAM=1. Never touches the
 * network: history is synthetic, the stream replays the shared fixture, and
 * the preview iframe points at the local /p/mock-preview page.
 */
export function createMockSource(projectId: string, scenario: string): WorkbenchSource {
  return new MockSource(projectId, scenario);
}
