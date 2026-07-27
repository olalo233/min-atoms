import { and, desc, eq, inArray, sql } from "drizzle-orm";

import {
  artifactVersions,
  buildRequests,
  generationEvents,
  generationJobs,
  projectMessages,
  projects,
  type BuildRequest,
  type GenerationJob,
  type Project,
} from "@/db/schema";
import { getDb } from "@/lib/db/client";
import {
  createGenerationJob,
  requeueGenerationForRevalidation,
} from "@/lib/generation/repository";
import { ACTIVE_GENERATION_STATUSES } from "@/lib/generation/types";

const PROJECT_NAME_LIMIT = 72;

export function normalizeBuildRequest(value: string): string {
  return value.trim();
}

export function getInitialProjectName(buildRequest: string): string {
  const normalized = normalizeBuildRequest(buildRequest).replace(/\s+/g, " ");
  const summary = normalized.slice(0, PROJECT_NAME_LIMIT);
  return `Project: ${summary}`;
}

export async function createProjectWithBuildRequest(
  ownerId: string,
  rawBuildRequest: string,
): Promise<{ project: Project; buildRequest: BuildRequest; job: GenerationJob }> {
  const content = normalizeBuildRequest(rawBuildRequest);
  if (!content) {
    throw new Error("Build request cannot be empty.");
  }

  const result = await getDb().transaction(async (transaction) => {
    const [project] = await transaction
      .insert(projects)
      .values({
        ownerId,
        name: getInitialProjectName(content),
      })
      .returning();

    const [buildRequest] = await transaction
      .insert(buildRequests)
      .values({ projectId: project.id, content })
      .returning();
    await transaction.insert(projectMessages).values({
      buildRequestId: buildRequest.id,
      content,
      mode: "build",
      projectId: project.id,
      role: "user",
      sequence: 1,
    });

    return { project, buildRequest };
  });

  // Persist the queued job here so the Route Handler owns scheduling via
  // `after()` instead of raw fire-and-forget inside the repository.
  const job = await createGenerationJob(result.project.id, result.buildRequest.id);
  return { ...result, job };
}

export async function listOwnedProjects(ownerId: string): Promise<Project[]> {
  return getDb()
    .select()
    .from(projects)
    .where(eq(projects.ownerId, ownerId))
    .orderBy(desc(projects.updatedAt));
}

export async function createOwnedFollowUpGeneration(
  ownerId: string,
  projectId: string,
  rawBuildRequest: string,
  baseVersionId: string,
): Promise<{ buildRequest: BuildRequest; job: typeof generationJobs.$inferSelect } | null> {
  const content = normalizeBuildRequest(rawBuildRequest);
  if (!content) throw new Error("Build request cannot be empty.");

  try {
    return await getDb().transaction(async (transaction) => {
      const [project] = await transaction
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.ownerId, ownerId)))
        .limit(1);
      if (!project) return null;

      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${projectId}))`,
      );

      const [active] = await transaction
        .select({ buildRequest: buildRequests, job: generationJobs })
        .from(generationJobs)
        .innerJoin(buildRequests, eq(generationJobs.buildRequestId, buildRequests.id))
        .where(and(
          eq(generationJobs.projectId, projectId),
          inArray(generationJobs.status, [...ACTIVE_GENERATION_STATUSES]),
        ))
        .orderBy(desc(generationJobs.createdAt))
        .limit(1);
      if (active) return active;

      const [baseVersion] = await transaction
        .select({ id: artifactVersions.id })
        .from(artifactVersions)
        .where(and(
          eq(artifactVersions.id, baseVersionId),
          eq(artifactVersions.projectId, projectId),
        ))
        .limit(1);
      if (!baseVersion) throw new Error("Base Version not found.");

      const [failedAttempt] = await transaction
        .select({ buildRequest: buildRequests })
        .from(generationJobs)
        .innerJoin(buildRequests, eq(generationJobs.buildRequestId, buildRequests.id))
        .where(and(
          eq(generationJobs.projectId, projectId),
          eq(generationJobs.status, "failed"),
          eq(buildRequests.baseVersionId, baseVersionId),
          eq(buildRequests.content, content),
        ))
        .orderBy(desc(generationJobs.createdAt))
        .limit(1);
      if (failedAttempt) {
        const [job] = await transaction
          .insert(generationJobs)
          .values({
            baseVersionId,
            buildRequestId: failedAttempt.buildRequest.id,
            projectId,
            status: "queued",
          })
          .returning();
        await transaction.insert(generationEvents).values({
          jobId: job.id,
          message: "Generation queued.",
          sequence: 1,
          stage: "queued",
        });
        return { buildRequest: failedAttempt.buildRequest, job };
      }

      const [buildRequest] = await transaction
        .insert(buildRequests)
        .values({ baseVersionId, content, projectId })
        .returning();
      const [lastMessage] = await transaction
        .select({ sequence: projectMessages.sequence })
        .from(projectMessages)
        .where(eq(projectMessages.projectId, projectId))
        .orderBy(desc(projectMessages.sequence))
        .limit(1);
      await transaction.insert(projectMessages).values({
        buildRequestId: buildRequest.id,
        content,
        mode: "build",
        projectId,
        role: "user",
        sequence: (lastMessage?.sequence ?? 0) + 1,
      });
      const [job] = await transaction
        .insert(generationJobs)
        .values({ baseVersionId, buildRequestId: buildRequest.id, projectId, status: "queued" })
        .returning();
      await transaction.insert(generationEvents).values({
        jobId: job.id,
        message: "Generation queued.",
        sequence: 1,
        stage: "queued",
      });
      await transaction
        .update(projects)
        .set({ updatedAt: new Date() })
        .where(eq(projects.id, projectId));
      return { buildRequest, job };
    });
  } catch (error) {
    const [active] = await getDb()
      .select({ buildRequest: buildRequests, job: generationJobs })
      .from(generationJobs)
      .innerJoin(buildRequests, eq(generationJobs.buildRequestId, buildRequests.id))
      .innerJoin(projects, eq(generationJobs.projectId, projects.id))
      .where(and(
        eq(generationJobs.projectId, projectId),
        eq(projects.ownerId, ownerId),
        inArray(generationJobs.status, [...ACTIVE_GENERATION_STATUSES]),
      ))
      .orderBy(desc(generationJobs.createdAt))
      .limit(1);
    if (active) return active;
    throw error;
  }
}

export async function retryOwnedGeneration(
  ownerId: string,
  projectId: string,
) {
  const [latest] = await getDb()
    .select({ job: generationJobs })
    .from(generationJobs)
    .innerJoin(projects, eq(generationJobs.projectId, projects.id))
    .where(and(eq(projects.id, projectId), eq(projects.ownerId, ownerId)))
    .orderBy(desc(generationJobs.createdAt))
    .limit(1);
  if (!latest) return null;

  // A generation endpoint is safe to repeat while a job is queued, running, or
  // already complete. Only a failed or cancelled latest job is retryable;
  // creating a second job after completion would create another Artifact
  // Version for the same request.
  if (latest.job.status !== "failed" && latest.job.status !== "cancelled") {
    return latest.job;
  }
  if (
    latest.job.status === "failed" &&
    latest.job.errorMessage === "artifact_invalid"
  ) {
    const requeued = await requeueGenerationForRevalidation(latest.job.id);
    if (requeued) return requeued;
  }

  return createGenerationJob(
    latest.job.projectId,
    latest.job.buildRequestId,
    latest.job.baseVersionId,
  );
}

export async function getOwnedProject(
  ownerId: string,
  projectId: string,
): Promise<{ project: Project; buildRequest: BuildRequest } | null> {
  const result = await getDb()
    .select({ project: projects, buildRequest: buildRequests })
    .from(projects)
    .innerJoin(buildRequests, eq(buildRequests.projectId, projects.id))
    .where(and(eq(projects.ownerId, ownerId), eq(projects.id, projectId)))
    .orderBy(buildRequests.createdAt)
    .limit(1);

  return result[0] ?? null;
}
export type DeleteOwnedProjectResult = "deleted" | "active" | "not found";

/**
 * Transactionally delete the exact project owned by `ownerId`. The project
 * advisory lock serializes this against concurrent generation work; an active
 * job rejects the delete with `active`. RESTRICT references into
 * `artifact_versions` (the project's active pointer plus every build request
 * and job base pointer) are cleared first so the cascade delete cannot stall.
 */
export async function deleteOwnedProject(
  ownerId: string,
  projectId: string,
): Promise<DeleteOwnedProjectResult> {
  return getDb().transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtext(${projectId}))`,
    );

    const [project] = await transaction
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.ownerId, ownerId)))
      .limit(1);
    if (!project) {
      return "not found";
    }

    const [active] = await transaction
      .select({ id: generationJobs.id })
      .from(generationJobs)
      .where(
        and(
          eq(generationJobs.projectId, projectId),
          inArray(generationJobs.status, [...ACTIVE_GENERATION_STATUSES]),
        ),
      )
      .limit(1);
    if (active) {
      return "active";
    }

    await transaction
      .update(projects)
      .set({ activeArtifactVersionId: null, updatedAt: new Date() })
      .where(eq(projects.id, projectId));
    await transaction
      .update(buildRequests)
      .set({ baseVersionId: null })
      .where(eq(buildRequests.projectId, projectId));
    await transaction
      .update(generationJobs)
      .set({ baseVersionId: null })
      .where(eq(generationJobs.projectId, projectId));

    await transaction
      .delete(projects)
      .where(and(eq(projects.id, projectId), eq(projects.ownerId, ownerId)));

    return "deleted";
  });
}
