import type { MessageDTO, ProjectDetail, RunDTO, RunEvent, VersionDTO } from "@min-atoms/protocol";

import { runtimeCopy, type RuntimePhase, type VmStatus } from "../runtime";

import type { RunMode } from "./source";

/** Granular run phase, combining the run row status with `status` events. */
export type RunPhase =
  | "queued"
  | "starting"
  | "running"
  | "verifying"
  | "repairing"
  | "committing"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface ToolStep {
  toolCallId: string;
  name: string;
  title: string;
  status: "running" | "done" | "failed";
  summary?: string;
}

export interface RunViewData {
  id: string;
  mode: RunMode;
  userMessageId: string | null;
  createdAt: string;
  /** Run-row timestamps; null while the run has not started/finished. */
  startedAt: string | null;
  finishedAt: string | null;
  phase: RunPhase;
  /** `detail` of the latest status event (e.g. cancel / failure copy). */
  statusDetail?: string;
  /** Accumulated visible text from `text` events. */
  text: string;
  hasTextEvents: boolean;
  hasThinking: boolean;
  steps: ToolStep[];
  version?: { versionId: string; number: number; summary: string };
  /** Raw `error` event messages, shown only inside the failure details fold. */
  errors: string[];
  /** Failure reason from the `failed` status event or the run row. */
  failedDetail?: string;
  firstEventAt?: string;
  lastEventAt?: string;
  /** Timestamp (ms) when the user pressed stop. */
  stopRequestedAt?: number;
  /** Set 10s after a stop request if the run is still not finished. */
  stopTimedOut?: boolean;
}

/** An optimistic user message that has not been acknowledged by the server. */
export interface LocalDraft {
  tempId: string;
  content: string;
  mode: RunMode;
  state: "sending" | "failed";
  createdAt: string;
}

export interface WorkbenchState {
  status: "loading" | "ready" | "error";
  projectId: string;
  projectName: string;
  currentVersionId: string | null;
  messages: MessageDTO[];
  drafts: LocalDraft[];
  runs: Record<string, RunViewData>;
  versions: VersionDTO[];
  lastEventId: number;
  vmUp: boolean | null;
  runtimePhase: RuntimePhase | null;
  runtimeDetail?: string;
  runtimeWaitingSince: number | null;
  runtimeWakePending: boolean;
  /** Set once; polling/events/version changes never rewrite it. */
  previewUrl: string | null;
  previewReady: boolean;
  /** Bumped only by the explicit refresh button to force an iframe reload. */
  previewKey: number;
}

export function isActivePhase(phase: RunPhase): boolean {
  return phase === "starting" || phase === "running" || phase === "verifying" || phase === "repairing" || phase === "committing";
}

function statusToPhase(status: RunDTO["status"]): RunPhase {
  return status;
}

function createRunView(run: {
  id: string;
  mode: RunMode;
  userMessageId: string | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  status: RunDTO["status"];
}): RunViewData {
  return {
    id: run.id,
    mode: run.mode,
    userMessageId: run.userMessageId,
    createdAt: run.createdAt,
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
    phase: statusToPhase(run.status),
    text: "",
    hasTextEvents: false,
    hasThinking: false,
    steps: [],
    errors: [],
  };
}

function applyRunEvent(run: RunViewData, event: RunEvent): void {
  if (!run.firstEventAt || event.at < run.firstEventAt) run.firstEventAt = event.at;
  if (!run.lastEventAt || event.at > run.lastEventAt) run.lastEventAt = event.at;
  switch (event.kind) {
    case "status":
      run.phase = event.status;
      if (event.detail) run.statusDetail = event.detail;
      if (event.status === "failed") run.failedDetail = event.detail ?? run.failedDetail;
      if (!run.startedAt && (event.status === "starting" || event.status === "running")) run.startedAt = event.at;
      if (event.status === "succeeded" || event.status === "failed" || event.status === "cancelled") run.finishedAt = event.at;
      break;
    case "text":
      run.text += event.delta;
      run.hasTextEvents = true;
      break;
    case "thinking":
      run.hasThinking = true;
      break;
    case "tool": {
      const existing = run.steps.find((step) => step.toolCallId === event.toolCallId);
      if (event.phase === "start") {
        if (existing) {
          existing.status = "running";
        } else {
          run.steps.push({ toolCallId: event.toolCallId, name: event.name, title: event.title, status: "running" });
        }
      } else if (existing) {
        existing.status = event.ok === false ? "failed" : "done";
        if (event.summary) existing.summary = event.summary;
        existing.title = event.title;
      } else {
        run.steps.push({
          toolCallId: event.toolCallId,
          name: event.name,
          title: event.title,
          status: event.ok === false ? "failed" : "done",
          summary: event.summary,
        });
      }
      break;
    }
    case "version":
      run.version = { versionId: event.versionId, number: event.number, summary: event.summary };
      break;
    case "error":
      run.errors.push(event.message);
      break;
  }
}

function runViewFromDTO(run: RunDTO): RunViewData {
  const view = createRunView({
    id: run.id,
    mode: run.mode,
    userMessageId: run.userMessageId,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    status: run.status,
  });
  if (run.error) view.failedDetail = run.error;
  for (const event of run.events ?? []) applyRunEvent(view, event);
  if (run.error && view.errors.length === 0 && run.status === "failed") view.errors.push(run.error);
  return view;
}

export class WorkbenchStore {
  private state: WorkbenchState;
  private listeners = new Set<() => void>();
  private draftCounter = 0;

  constructor(projectId: string) {
    this.state = {
      status: "loading",
      projectId,
      projectName: "",
      currentVersionId: null,
      messages: [],
      drafts: [],
      runs: {},
      versions: [],
      lastEventId: 0,
      vmUp: null,
      runtimePhase: null,
      runtimeWaitingSince: Date.now(),
      runtimeWakePending: false,
      previewUrl: null,
      previewReady: false,
      previewKey: 0,
    };
  }

  getSnapshot = (): WorkbenchState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private emit(): void {
    this.state = { ...this.state };
    for (const listener of this.listeners) listener();
  }

  loadDetail(detail: ProjectDetail): void {
    const runs: Record<string, RunViewData> = {};
    for (const run of detail.runs) runs[run.id] = runViewFromDTO(run);
    this.state = {
      ...this.state,
      status: "ready",
      projectName: detail.name,
      currentVersionId: detail.currentVersionId,
      messages: [...detail.messages],
      runs,
      versions: [...detail.versions],
      lastEventId: detail.lastEventId,
    };
    this.emit();
  }

  loadFailed(): void {
    this.state = { ...this.state, status: "error" };
    this.emit();
  }

  /** Apply one streamed event; ids at or below lastEventId are duplicates. */
  applyEvent(id: number, event: RunEvent): void {
    if (id <= this.state.lastEventId) return;
    this.state.lastEventId = id;
    let run = this.state.runs[event.runId];
    if (!run) {
      run = createRunView({ id: event.runId, mode: "build", userMessageId: null, createdAt: event.at, status: "queued" });
      this.state.runs[event.runId] = run;
    }
    applyRunEvent(run, event);
    if (event.kind === "version") {
      if (!this.state.versions.some((v) => v.id === event.versionId)) {
        this.state.versions = [
          ...this.state.versions,
          {
            id: event.versionId,
            projectId: this.state.projectId,
            number: event.number,
            commitSha: event.commitSha,
            summary: event.summary,
            runId: event.runId,
            screenshot: false,
            createdAt: event.at,
          },
        ];
      }
      this.state.currentVersionId = event.versionId;
    }
    this.emit();
  }

  setVmStatus(status: VmStatus): void {
    this.state.vmUp = status.up;
    this.state.runtimePhase = status.phase;
    this.state.runtimeDetail = status.detail;
    if (!status.up) {
      this.state.previewReady = false;
      this.state.runtimeWaitingSince ??= Date.now();
    }
    this.emit();
  }

  setRuntimeWakePending(pending: boolean): void {
    this.state.runtimeWakePending = pending;
    this.emit();
  }

  /** Called when ensure() succeeded. The iframe src is only ever set once. */
  setPreviewReady(previewUrl: string): void {
    if (!this.state.previewUrl) this.state.previewUrl = previewUrl;
    this.state.previewReady = true;
    this.state.runtimeWaitingSince = null;
    this.emit();
  }

  refreshPreview(): void {
    this.state.previewKey += 1;
    this.emit();
  }

  addDraft(content: string, mode: RunMode): string {
    this.draftCounter += 1;
    const tempId = `draft-${this.draftCounter}`;
    this.state.drafts = [...this.state.drafts, { tempId, content, mode, state: "sending", createdAt: new Date().toISOString() }];
    this.emit();
    return tempId;
  }

  markDraftSending(tempId: string): void {
    const draft = this.state.drafts.find((d) => d.tempId === tempId);
    if (!draft) return;
    draft.state = "sending";
    this.emit();
  }

  failDraft(tempId: string): void {
    const draft = this.state.drafts.find((d) => d.tempId === tempId);
    if (!draft) return;
    draft.state = "failed";
    this.emit();
  }

  confirmDraft(tempId: string, message: MessageDTO, run: RunDTO): void {
    this.state.drafts = this.state.drafts.filter((d) => d.tempId !== tempId);
    if (!this.state.messages.some((m) => m.id === message.id)) {
      this.state.messages = [...this.state.messages, message];
    }
    const existing = this.state.runs[run.id];
    if (existing) {
      existing.userMessageId = message.id;
      existing.mode = run.mode;
      if (run.startedAt) existing.startedAt = run.startedAt;
      if (run.finishedAt) existing.finishedAt = run.finishedAt;
    } else {
      this.state.runs[run.id] = runViewFromDTO(run);
    }
    this.emit();
  }

  markStopRequested(runId: string): void {
    const run = this.state.runs[runId];
    if (!run) return;
    run.stopRequestedAt = Date.now();
    run.stopTimedOut = false;
    this.emit();
  }

  markStopTimedOut(runId: string): void {
    const run = this.state.runs[runId];
    if (!run || !run.stopRequestedAt || !isActivePhase(run.phase)) return;
    run.stopTimedOut = true;
    this.emit();
  }

  /** Locally apply a completed restore: note message + new current version. */
  applyRestore(version: VersionDTO, restoredNumber: number): void {
    if (!this.state.versions.some((v) => v.id === version.id)) {
      this.state.versions = [...this.state.versions, version];
    }
    this.state.currentVersionId = version.id;
    const maxSeq = this.state.messages.reduce((max, m) => Math.max(max, m.seq), 0);
    this.state.messages = [
      ...this.state.messages,
      {
        id: `local-restore-${version.id}`,
        seq: maxSeq + 1,
        role: "assistant",
        mode: "build",
        content: `已恢复到版本 ${restoredNumber}`,
        runId: null,
        versionId: version.id,
        createdAt: version.createdAt,
      },
    ];
    this.emit();
  }
}

export type TimelineItem =
  | { key: string; type: "user"; message: MessageDTO }
  | { key: string; type: "run"; run: RunViewData; finalText: string | null }
  | { key: string; type: "note"; message: MessageDTO; version?: VersionDTO }
  | { key: string; type: "draft"; draft: LocalDraft };

/**
 * Interleave messages and runs into the conversation. A run renders directly
 * after its user message; the assistant message written at run end becomes
 * the run body for finished runs (their events carry no text). Assistant
 * messages without a run (restore notes) render as standalone small text.
 */
export function buildTimeline(state: WorkbenchState): TimelineItem[] {
  const items: TimelineItem[] = [];
  const messages = [...state.messages].sort((a, b) => a.seq - b.seq);
  const assistantTextByRun = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "assistant" && message.runId) assistantTextByRun.set(message.runId, message.content);
  }
  const runText = (run: RunViewData): string | null =>
    run.hasTextEvents ? run.text : (assistantTextByRun.get(run.id) ?? null);

  const attached = new Set<string>();
  for (const message of messages) {
    if (message.role === "user") {
      items.push({ key: `u-${message.id}`, type: "user", message });
      const runsForMessage = Object.values(state.runs)
        .filter((run) => run.userMessageId === message.id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const run of runsForMessage) {
        attached.add(run.id);
        items.push({ key: `r-${run.id}`, type: "run", run, finalText: runText(run) });
      }
    } else if (message.runId && state.runs[message.runId]) {
      // Absorbed into the run block as its final text.
    } else {
      items.push({
        key: `a-${message.id}`,
        type: "note",
        message,
        version: message.versionId ? state.versions.find((v) => v.id === message.versionId) : undefined,
      });
    }
  }
  const orphans = Object.values(state.runs)
    .filter((run) => !attached.has(run.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const run of orphans) {
    items.push({ key: `r-${run.id}`, type: "run", run, finalText: runText(run) });
  }
  for (const draft of state.drafts) {
    items.push({ key: `d-${draft.tempId}`, type: "draft", draft });
  }
  return items;
}

export function findActiveRun(state: WorkbenchState): RunViewData | undefined {
  return Object.values(state.runs)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .find((run) => isActivePhase(run.phase));
}

/** Restore/delete are blocked while a run is queued or running (ux §7.5). */
export function hasBlockingRun(state: WorkbenchState): boolean {
  if (state.drafts.some((draft) => draft.state === "sending")) return true;
  return Object.values(state.runs).some((run) => run.phase === "queued" || isActivePhase(run.phase));
}

/** Status line copy for a run (ux §6.2/§10); null hides the line. */
export function statusLineText(run: RunViewData, vmUp: boolean | null, runtimePhase: RuntimePhase | null = null): string | null {
  if (run.stopTimedOut && isActivePhase(run.phase)) return "正在停止…";
  switch (run.phase) {
    case "queued":
      return vmUp !== true ? runtimeCopy(runtimePhase).line : "排队中，前一个任务完成后开始";
    case "starting":
      return run.statusDetail ?? "准备环境…";
    case "verifying":
      return "正在检查应用能否运行…";
    case "repairing":
      return run.statusDetail ?? "发现问题，自动修复中…";
    case "committing":
      return "正在保存版本…";
    case "running": {
      const activeStep = run.steps.findLast((step) => step.status === "running");
      if (activeStep) return `正在${activeStep.title}…`;
      if (!run.hasTextEvents) return "正在思考…";
      return null;
    }
    default:
      return null;
  }
}

/** "已停止，应用已回到版本 N"; N derived from versions when not in detail. */
export function cancelledNote(state: WorkbenchState, run: RunViewData): string {
  if (run.statusDetail) return run.statusDetail;
  const at = Date.parse(run.finishedAt ?? run.lastEventAt ?? run.createdAt);
  const candidates = state.versions.filter((v) => Date.parse(v.createdAt) <= at);
  if (candidates.length === 0) return "已停止";
  const number = Math.max(...candidates.map((v) => v.number));
  return `已停止，应用已回到版本 ${number}`;
}

/** Duration label for the folded step list, e.g. "2 分 13 秒". */
export function runDurationText(run: RunViewData): string | null {
  // Prefer the run row's start/finish timestamps (queue wait excluded);
  // fall back to first/last event times for live runs.
  const start = run.startedAt ?? run.firstEventAt;
  const end = run.finishedAt ?? run.lastEventAt;
  if (!start || !end) return null;
  const ms = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
}

export function nextVersionNumber(state: WorkbenchState): number {
  return state.versions.reduce((max, v) => Math.max(max, v.number), 0) + 1;
}
