import { appendMessage, projects, runs, runEvents } from "@min-atoms/db";
import * as schema from "@min-atoms/db/schema";
import { RunEventSchema, ManagerStreamEventSchema, type RunEvent } from "@min-atoms/protocol";
import { and, asc, eq, gt, inArray, sql, type ExtractTablesWithRelations } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { ManagerError } from "./errors";

export type StoredEvent = { id: number; event: RunEvent };
export type RuntimeProject = { id: string; previewLabel: string };

export interface ManagerStore {
  project(id: string): Promise<RuntimeProject | undefined>;
  busy(id: string): Promise<boolean>;
  running(id: string): Promise<boolean>;
  backlog(projectId: string, after: number): Promise<StoredEvent[]>;
  appendEvents(projectId: string, events: RunEvent[]): Promise<StoredEvent[]>;
  recover(now: Date): Promise<Array<{ projectId: string; records: StoredEvent[] }>>;
  queuedProjects(): Promise<string[]>;
}

function envelope(row: { id: number; payload: unknown }): StoredEvent {
  return ManagerStreamEventSchema.parse({ id: row.id, event: row.payload });
}

// The same SQL implementation runs against the accepted postgres.js client and
// credential-free PGlite in tests. It does not create a connection at import time.
export function createManagerStore<TResult extends PgQueryResultHKT>(
  db: PgDatabase<TResult, typeof schema, ExtractTablesWithRelations<typeof schema>>,
): ManagerStore {
  return {
    async project(id) {
      const [row] = await db.select({ id: projects.id, previewLabel: projects.previewLabel })
        .from(projects).where(eq(projects.id, id));
      return row;
    },
    async busy(id) {
      const [row] = await db.select({ id: runs.id }).from(runs)
        .where(and(eq(runs.projectId, id), inArray(runs.status, ["running", "queued"]))).limit(1);
      return !!row;
    },
    async running(id) {
      const [row] = await db.select({ id: runs.id }).from(runs)
        .where(and(eq(runs.projectId, id), eq(runs.status, "running"))).limit(1);
      return !!row;
    },
    async backlog(projectId, after) {
      const rows = await db.select().from(runEvents)
        .where(and(eq(runEvents.projectId, projectId), gt(runEvents.id, after))).orderBy(asc(runEvents.id));
      return rows.map(envelope);
    },
    async appendEvents(projectId, input) {
      const events = input.map(event => RunEventSchema.parse(event));
      if (!events.length) return [];
      return db.transaction(async tx => {
        // Serialize event writers for this project before assigning/checking seq.
        const [project] = await tx.select({ id: projects.id }).from(projects)
          .where(eq(projects.id, projectId)).for("update");
        if (!project) throw new ManagerError(404, "Project not found");
        const nextSeq = new Map<string, number>();
        for (const event of events) {
          if (!nextSeq.has(event.runId)) {
            const [run] = await tx.select({ id: runs.id }).from(runs)
              .where(and(eq(runs.id, event.runId), eq(runs.projectId, projectId))).for("update");
            if (!run) throw new ManagerError(409, "Run does not belong to project");
            const [last] = await tx.select({ seq: sql<number>`coalesce(max(${runEvents.seq}), 0)`.mapWith(Number) })
              .from(runEvents).where(eq(runEvents.runId, event.runId));
            nextSeq.set(event.runId, last.seq + 1);
          }
          if (event.seq !== nextSeq.get(event.runId)) throw new ManagerError(409, "Invalid next run event sequence");
          nextSeq.set(event.runId, event.seq + 1);
        }
        const rows = await tx.insert(runEvents).values(events.map(event => ({
          projectId, runId: event.runId, seq: event.seq, kind: event.kind, payload: event,
        }))).returning();
        return rows.map(envelope).sort((a, b) => a.id - b.id);
      });
    },
    async recover(now) {
      return db.transaction(async tx => {
        const interrupted = await tx.select().from(runs).where(eq(runs.status, "running"))
          .orderBy(asc(runs.projectId), asc(runs.id));
        const recovered: Array<{ projectId: string; records: StoredEvent[] }> = [];
        for (const candidate of interrupted) {
          // Match appendMessage's lock order. Recheck status under the run lock.
          await tx.select({ id: projects.id }).from(projects)
            .where(eq(projects.id, candidate.projectId)).for("update");
          const [run] = await tx.select().from(runs)
            .where(and(eq(runs.id, candidate.id), eq(runs.status, "running"))).for("update");
          if (!run) continue;
          const [last] = await tx.select({ seq: sql<number>`coalesce(max(${runEvents.seq}), 0)`.mapWith(Number) })
            .from(runEvents).where(eq(runEvents.runId, run.id));
          const base = { runId: run.id, at: now.toISOString() };
          const events: RunEvent[] = [
            { ...base, seq: last.seq + 1, kind: "error", message: "环境重启" },
            { ...base, seq: last.seq + 2, kind: "status", status: "failed", detail: "环境重启" },
          ];
          await tx.update(runs).set({ status: "failed", error: "环境重启", finishedAt: now }).where(eq(runs.id, run.id));
          const rows = await tx.insert(runEvents).values(events.map(event => ({
            projectId: run.projectId, runId: run.id, seq: event.seq, kind: event.kind, payload: event,
          }))).returning();
          await appendMessage(tx, run.projectId, {
            role: "assistant", mode: run.mode, content: "环境重启", runId: run.id, versionId: null,
          });
          recovered.push({ projectId: run.projectId, records: rows.map(envelope) });
        }
        return recovered;
      });
    },
    async queuedProjects() {
      const rows = await db.selectDistinct({ projectId: runs.projectId }).from(runs)
        .where(eq(runs.status, "queued")).orderBy(asc(runs.projectId));
      return rows.map(row => row.projectId);
    },
  };
}
