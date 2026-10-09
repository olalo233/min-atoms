import type { Hono } from "hono";
import { appendMessage, projects, runs, versions } from "@min-atoms/db";
import * as schema from "@min-atoms/db/schema";
import { ManagerRestoreRequestSchema, ManagerRestoreResponseSchema, type VersionDTO } from "@min-atoms/protocol";
import { and, eq, inArray, sql, type ExtractTablesWithRelations } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { ManagerError, validateProjectId } from "./errors";
import { runCommand, type RunCommand } from "./run-process";
import type { ProjectRuntime } from "./runtime";
import type { createManager } from "./manager";

const commitShaPattern = /^[0-9a-f]{40}$/;

export type RestoreTargetVersion = { id: string; number: number; commitSha: string };
// File work handed to the caller while the project row lock is held. It returns
// the commit SHA of the new linear version; the store persists the version row
// and the restore message in the same transaction only if this resolves.
export type RestoreApply = (target: RestoreTargetVersion, next: number) => Promise<{ commitSha: string }>;

export interface RestoreStore {
  restore(projectId: string, versionId: string, apply: RestoreApply): Promise<VersionDTO>;
}

// Same SQL implementation runs against the accepted postgres.js client and the
// credential-free PGlite used in tests. No connection is created at import time.
export function createRestoreStore<TResult extends PgQueryResultHKT>(
  db: PgDatabase<TResult, typeof schema, ExtractTablesWithRelations<typeof schema>>,
  options: { now?: () => Date } = {},
): RestoreStore {
  const now = options.now ?? (() => new Date());
  return {
    async restore(projectId, versionId, apply) {
      return db.transaction(async tx => {
        // Lock the project row exactly like appendMessage. This serializes a
        // restore against another restore and against new queued messages.
        const [project] = await tx.select({ id: projects.id }).from(projects)
          .where(eq(projects.id, projectId)).for("update");
        if (!project) throw new ManagerError(404, "Project not found");
        const [target] = await tx.select({ id: versions.id, number: versions.number, commitSha: versions.commitSha })
          .from(versions).where(and(eq(versions.id, versionId), eq(versions.projectId, projectId)));
        if (!target) throw new ManagerError(404, "Version not found");
        // Checked after the lock, before any file work.
        const [busy] = await tx.select({ id: runs.id }).from(runs)
          .where(and(eq(runs.projectId, projectId), inArray(runs.status, ["queued", "running"]))).limit(1);
        if (busy) throw new ManagerError(409, "Project has running or queued work");
        const [last] = await tx.select({ number: sql<number>`coalesce(max(${versions.number}), 0)`.mapWith(Number) })
          .from(versions).where(eq(versions.projectId, projectId));
        const number = last.number + 1;
        const { commitSha } = await apply(target, number);
        const summary = `恢复到版本 ${target.number}`;
        const [version] = await tx.insert(versions)
          .values({ projectId, number, commitSha, summary, runId: null, screenshot: false }).returning();
        await tx.update(projects).set({ currentVersionId: version.id, updatedAt: now() })
          .where(eq(projects.id, projectId));
        await appendMessage(tx, projectId, { role: "assistant", mode: "build",
          content: `已恢复到版本 ${target.number}`, runId: null, versionId: version.id });
        return ManagerRestoreResponseSchema.parse({ ...version, createdAt: new Date(version.createdAt).toISOString() });
      });
    },
  };
}

// architecture.md §8: restore an older version as a new linear commit without
// touching application data. Every command is argv-safe inside the owned
// project container; the new commit tree must equal the target tree.
export function createRestore(options: {
  runtime: Pick<ProjectRuntime, "project" | "ensure">;
  store: RestoreStore;
  command: RunCommand;
}): (projectId: string, versionId: string) => Promise<VersionDTO> {
  const { runtime, store, command } = options;
  return async function restore(projectId, versionId) {
    // Validates the UUID, canonicalizes the ID and rejects unknown projects.
    const project = await runtime.project(projectId);
    // Ensure runs before the locked transaction: ownership/readiness is a
    // prerequisite, and the store lock must stay free of unrelated DB reads.
    await runtime.ensure(project.id, project.previewLabel);
    return store.restore(project.id, versionId, async target => {
      if (!commitShaPattern.test(target.commitSha)) throw new ManagerError(409, "Invalid stored version commit");
      const container = project.previewLabel;
      const run = async (argv: string[]) => {
        const result = await command(container, argv);
        if (result.exitCode !== 0) throw new ManagerError(503, `Restore command failed: ${argv.join(" ")}`);
        return result.output;
      };
      // The target commit must exist in this workspace before any file changes.
      await run(["git", "cat-file", "-e", `${target.commitSha}^{commit}`]);
      const packageBefore = await hashPackage(container, command);
      await run(["git", "restore", `--source=${target.commitSha}`, "--staged", "--worktree", "--", "."]);
      await run(["git", "clean", "-fd", "-e", "node_modules", "-e", ".ma"]);
      const packageAfter = await hashPackage(container, command);
      if (packageBefore !== packageAfter) await run(["bun", "install"]);
      await run(["git", "add", "-A"]);
      await run(["git", "commit", "--allow-empty", "-m", `restore v${target.number}`]);
      const commitSha = (await run(["git", "rev-parse", "HEAD"])).trim();
      if (!commitShaPattern.test(commitSha)) throw new ManagerError(503, "Unable to read restore commit");
      const tree = (await run(["git", "rev-parse", "HEAD^{tree}"])).trim();
      const targetTree = (await run(["git", "rev-parse", `${target.commitSha}^{tree}`])).trim();
      if (tree !== targetTree) throw new ManagerError(503, "Restored tree does not match the target version");
      return { commitSha };
    });
  };
}

// The package.json content id; null when the file is absent either side.
async function hashPackage(container: string, command: RunCommand): Promise<string | null> {
  const result = await command(container, ["git", "hash-object", "package.json"]);
  return result.exitCode === 0 ? result.output.trim() : null;
}

export function registerRestoreRoute(app: Hono,
  restore: (projectId: string, versionId: string) => Promise<VersionDTO>) {
  app.post("/projects/:id/restore", async c => {
    validateProjectId(c.req.param("id"));
    const body = ManagerRestoreRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) throw new ManagerError(400, "Invalid restore body");
    return c.json(await restore(c.req.param("id"), body.data.versionId));
  });
}

export function installRestore(manager: ReturnType<typeof createManager>, options: {
  store: RestoreStore; command?: RunCommand;
}) {
  const restore = createRestore({ runtime: manager.runtime, store: options.store,
    command: options.command ?? runCommand });
  registerRestoreRoute(manager.app, restore);
  return restore;
}
