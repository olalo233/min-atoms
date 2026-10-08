import {
  appendMessage,
  messages,
  previewHosts,
  projects,
  runEvents,
  runs,
  versions,
} from "@min-atoms/db";
import type {
  MessageDTO,
  ProjectDetail,
  ProjectSummary,
  RunDTO,
  RunEvent,
} from "@min-atoms/protocol";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { toMessageDTO, toProjectSummary, toRunDTO, toRunEvent, toVersionDTO } from "./dto";

/** A queued run is already owned by its project: the user cannot delete or restore past it. */
const ACTIVE_RUN_STATUSES = ["queued", "running"] as const;

/** Message mode comes from the shared DTO rather than a parallel local enum. */
type RunMode = MessageDTO["mode"];

export type OwnedProject = { id: string; previewLabel: string };

export class PreviewHostUnavailableError extends Error {
  constructor() {
    super("No preview host is available.");
    this.name = "PreviewHostUnavailableError";
  }
}

export async function findOwnedProject(projectId: string, ownerId: string): Promise<OwnedProject | null> {
  const [row] = await getDb()
    .select({ id: projects.id, previewLabel: projects.previewLabel })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerId, ownerId)))
    .limit(1);
  return row ?? null;
}

export async function listProjectSummaries(ownerId: string): Promise<ProjectSummary[]> {
  const db = getDb();
  const projectRows = await db
    .select()
    .from(projects)
    .where(eq(projects.ownerId, ownerId))
    .orderBy(desc(projects.updatedAt));
  if (projectRows.length === 0) {
    return [];
  }

  const projectIds = projectRows.map((project) => project.id);
  const [versionRows, activeRunRows] = await Promise.all([
    db
      .select({
        projectId: versions.projectId,
        id: versions.id,
        number: versions.number,
        commitSha: versions.commitSha,
        screenshot: versions.screenshot,
      })
      .from(versions)
      .where(inArray(versions.projectId, projectIds)),
    db
      .selectDistinct({ projectId: runs.projectId })
      .from(runs)
      .where(and(inArray(runs.projectId, projectIds), inArray(runs.status, [...ACTIVE_RUN_STATUSES]))),
  ]);
  const projectsWithActiveRun = new Set(activeRunRows.map((row) => row.projectId));

  return projectRows.map((project) =>
    toProjectSummary(project, versionRows, projectsWithActiveRun.has(project.id)),
  );
}

export async function getProjectDetail(projectId: string, ownerId: string): Promise<ProjectDetail | null> {
  // The project, its history and the SSE cursor must come from one consistent
  // snapshot. Under READ COMMITTED each statement takes a fresh snapshot, so an
  // event committed between the events read and a separate cursor read would be
  // absent from history yet sit below `lastEventId`; SSE with `after=` would then
  // skip it forever. An explicit repeatable-read transaction pins one snapshot.
  return getDb().transaction(
    async (tx) => {
      const [project] = await tx
        .select()
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.ownerId, ownerId)))
        .limit(1);
      if (!project) {
        return null;
      }

      const [messageRows, runRows, versionRows, eventRows] = await Promise.all([
        tx.select().from(messages).where(eq(messages.projectId, projectId)).orderBy(messages.seq),
        tx.select().from(runs).where(eq(runs.projectId, projectId)).orderBy(runs.createdAt),
        tx.select().from(versions).where(eq(versions.projectId, projectId)).orderBy(versions.number),
        tx.select().from(runEvents).where(eq(runEvents.projectId, projectId)).orderBy(runEvents.id),
      ]);

      // Derive the cursor from the very rows returned above, so it can never point
      // past the history. Anything the manager commits after this snapshot gets a
      // higher id and is replayed by the client's `after=<lastEventId>`.
      const lastEventId = eventRows.reduce((max, row) => (row.id > max ? row.id : max), 0);

      const eventsByRun = new Map<string, RunEvent[]>();
      for (const row of eventRows) {
        const event = toRunEvent(row);
        if (!event) {
          continue;
        }
        const bucket = eventsByRun.get(row.runId);
        if (bucket) {
          bucket.push(event);
        } else {
          eventsByRun.set(row.runId, [event]);
        }
      }

      return {
        id: project.id,
        name: project.name,
        previewLabel: project.previewLabel,
        currentVersionId: project.currentVersionId,
        createdAt: project.createdAt.toISOString(),
        updatedAt: project.updatedAt.toISOString(),
        messages: messageRows.map(toMessageDTO),
        runs: runRows.map((run) => toRunDTO(run, eventsByRun.get(run.id) ?? [])),
        versions: versionRows.map(toVersionDTO),
        lastEventId,
      };
    },
    { isolationLevel: "repeatable read" },
  );
}

/**
 * Claims a preview host from the pool and creates the project's first user
 * message plus its queued build run in one transaction (architecture.md §9).
 */
export async function createProjectWithRun(input: {
  ownerId: string;
  name: string;
  prompt: string;
}): Promise<{ id: string; previewLabel: string }> {
  return getDb().transaction(async (tx) => {
    const [host] = await tx
      .select({ label: previewHosts.label })
      .from(previewHosts)
      .where(isNull(previewHosts.projectId))
      .orderBy(previewHosts.label)
      .limit(1)
      .for("update", { skipLocked: true });
    if (!host) {
      throw new PreviewHostUnavailableError();
    }

    const [project] = await tx
      .insert(projects)
      .values({ ownerId: input.ownerId, name: input.name, previewLabel: host.label })
      .returning();
    await tx.update(previewHosts).set({ projectId: project.id }).where(eq(previewHosts.label, host.label));

    const message = await appendMessage(tx, project.id, {
      role: "user",
      mode: "build",
      content: input.prompt,
      runId: null,
      versionId: null,
    });
    const [run] = await tx
      .insert(runs)
      .values({ projectId: project.id, userMessageId: message.id, mode: "build", status: "queued" })
      .returning();
    // Link the triggering run on the user message too, so the client can group
    // a message with its run without a second lookup.
    await tx.update(messages).set({ runId: run.id }).where(eq(messages.id, message.id));

    return { id: project.id, previewLabel: host.label };
  });
}

/** Queues a user message and its run. Never calls the manager, so a stopped VM still accepts messages. */
export async function appendUserMessageAndRun(input: {
  projectId: string;
  content: string;
  mode: RunMode;
}): Promise<{ message: MessageDTO; run: RunDTO }> {
  return getDb().transaction(async (tx) => {
    const message = await appendMessage(tx, input.projectId, {
      role: "user",
      mode: input.mode,
      content: input.content,
      runId: null,
      versionId: null,
    });
    const [run] = await tx
      .insert(runs)
      .values({
        projectId: input.projectId,
        userMessageId: message.id,
        mode: input.mode,
        status: "queued",
      })
      .returning();
    const [linked] = await tx
      .update(messages)
      .set({ runId: run.id })
      .where(eq(messages.id, message.id))
      .returning();
    return { message: toMessageDTO(linked), run: toRunDTO(run, []) };
  });
}

export async function hasActiveRun(projectId: string): Promise<boolean> {
  return hasRunInStatuses(projectId, ACTIVE_RUN_STATUSES);
}

export async function hasQueuedRun(projectId: string): Promise<boolean> {
  return hasRunInStatuses(projectId, ["queued"]);
}

async function hasRunInStatuses(projectId: string, statuses: readonly ("queued" | "running")[]): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.projectId, projectId), inArray(runs.status, [...statuses])))
    .limit(1);
  return Boolean(row);
}

export async function runBelongsToProject(projectId: string, runId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.projectId, projectId), eq(runs.id, runId)))
    .limit(1);
  return Boolean(row);
}

export async function versionBelongsToProject(projectId: string, versionId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: versions.id })
    .from(versions)
    .where(and(eq(versions.projectId, projectId), eq(versions.id, versionId)))
    .limit(1);
  return Boolean(row);
}

/** Outcome of a guarded project delete. */
export type DeleteProjectOutcome = "deleted" | "not_found" | "conflict";

/**
 * Deletes the project, its history and its preview-host claim in the same
 * transaction that holds the project row lock `appendMessage` uses. `removeManager`
 * runs while the lock is held, so a message writer either commits its queued run
 * before the lock is taken (the active-run check then returns "conflict") or waits
 * until after the delete committed and finds no project. A run accepted by HTTP is
 * therefore never cascaded away by a concurrent DELETE.
 */
export async function deleteOwnedProject(input: {
  projectId: string;
  ownerId: string;
  removeManager: () => Promise<void>;
}): Promise<DeleteProjectOutcome> {
  return getDb().transaction(async (tx) => {
    const [project] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, input.projectId), eq(projects.ownerId, input.ownerId)))
      .limit(1)
      .for("update");
    if (!project) {
      return "not_found";
    }

    const [activeRun] = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.projectId, input.projectId), inArray(runs.status, [...ACTIVE_RUN_STATUSES])))
      .limit(1);
    if (activeRun) {
      return "conflict";
    }

    // Throwing rolls the transaction back, keeping the rows and the host claim
    // when the manager cannot take the delete.
    await input.removeManager();

    await tx.update(previewHosts).set({ projectId: null }).where(eq(previewHosts.projectId, input.projectId));
    await tx.delete(projects).where(eq(projects.id, input.projectId));
    return "deleted";
  });
}
