import type { Message, Run, RunEventRecord, Version } from "@min-atoms/db";
import {
  RunEventSchema,
  type MessageDTO,
  type ProjectSummary,
  type RunDTO,
  type RunEvent,
  type VersionDTO,
} from "@min-atoms/protocol";

type RunStatus = RunDTO["status"];

const TERMINAL_RUN_STATUSES = new Set<RunStatus>(["succeeded", "failed", "cancelled"]);
// A finished run's prose lives in the assistant message, so its transient stream
// events are not replayed on reload (architecture.md §10).
const TERMINAL_EVENT_KINDS = new Set<RunEvent["kind"]>(["tool", "version", "error"]);

export function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export function toMessageDTO(row: Message): MessageDTO {
  return {
    id: row.id,
    seq: row.seq,
    role: row.role,
    mode: row.mode,
    content: row.content,
    runId: row.runId,
    versionId: row.versionId,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toRunEvent(row: RunEventRecord): RunEvent | null {
  const payload = row.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  const fields = payload as Record<string, unknown>;
  const parsed = RunEventSchema.safeParse({
    ...fields,
    kind: row.kind,
    runId: row.runId,
    seq: row.seq,
    at: typeof fields.at === "string" ? fields.at : row.createdAt.toISOString(),
  });
  return parsed.success ? parsed.data : null;
}

export function filterRunEvents(status: RunStatus, events: RunEvent[]): RunEvent[] {
  if (!TERMINAL_RUN_STATUSES.has(status)) {
    return events;
  }
  return events.filter((event) => TERMINAL_EVENT_KINDS.has(event.kind));
}

export function toRunDTO(row: Run, events: RunEvent[]): RunDTO {
  return {
    id: row.id,
    projectId: row.projectId,
    userMessageId: row.userMessageId,
    mode: row.mode,
    status: row.status,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    startedAt: toIso(row.startedAt),
    finishedAt: toIso(row.finishedAt),
    events: filterRunEvents(row.status, events),
  };
}

export function toVersionDTO(row: Version): VersionDTO {
  return {
    id: row.id,
    projectId: row.projectId,
    number: row.number,
    commitSha: row.commitSha,
    summary: row.summary,
    runId: row.runId,
    screenshot: row.screenshot,
    createdAt: row.createdAt.toISOString(),
  };
}

export type ProjectVersionFacts = {
  projectId: string;
  id: string;
  number: number;
  commitSha: string;
  screenshot: boolean;
};

export function toProjectSummary(
  project: { id: string; name: string; updatedAt: Date; currentVersionId: string | null },
  versions: ProjectVersionFacts[],
  hasActiveRun: boolean,
): ProjectSummary {
  let latest: ProjectVersionFacts | null = null;
  let current: ProjectVersionFacts | null = null;
  for (const version of versions) {
    if (version.projectId !== project.id) {
      continue;
    }
    if (!latest || version.number > latest.number) {
      latest = version;
    }
    if (project.currentVersionId && version.id === project.currentVersionId) {
      current = version;
    }
  }

  return {
    id: project.id,
    name: project.name,
    updatedAt: project.updatedAt.toISOString(),
    hasRunningRun: hasActiveRun,
    latestVersionNumber: latest ? latest.number : null,
    // The screenshot file is named after the commit sha (architecture.md §7).
    currentScreenshotSha: current?.screenshot ? current.commitSha : null,
  };
}
