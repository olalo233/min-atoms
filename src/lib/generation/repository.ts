import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import {
  artifactVersions,
  buildRequests,
  generationEvents,
  generationJobs,
  projects,
  type ArtifactVersion,
  type GenerationEvent,
  type GenerationJob,
} from "@/db/schema";
import { getDb } from "@/lib/db/client";
import {
  type ArtifactFiles,
  ACTIVE_GENERATION_STATUSES,
  type ActiveGenerationStage,
  type BaseArtifact,
  type GenerationInput,
  type GenerationSnapshot,
} from "@/lib/generation/types";
import { validateArtifact } from "@/lib/generation/validator";

export async function createGenerationJob(
  projectId: string,
  buildRequestId: string,
  baseVersionId: string | null = null,
): Promise<GenerationJob> {
  return getDb().transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtext(${projectId}))`,
    );
    const [inserted] = await transaction
      .insert(generationJobs)
      .values({
        projectId,
        buildRequestId,
        baseVersionId,
        status: "queued",
      })
      .onConflictDoNothing()
      .returning();

    if (inserted) {
      await transaction.insert(generationEvents).values({
        jobId: inserted.id,
        sequence: 1,
        stage: "queued",
        message: "Generation queued.",
      });
      return inserted;
    }

    const [activeJob] = await transaction
      .select()
      .from(generationJobs)
      .where(
        and(
          eq(generationJobs.projectId, projectId),
          inArray(generationJobs.status, [...ACTIVE_GENERATION_STATUSES]),
        ),
      )
      .orderBy(desc(generationJobs.createdAt))
      .limit(1);

    if (!activeJob) {
      throw new Error("Unable to create a generation job.");
    }

    return activeJob;
  });
}

export async function getOwnedGenerationSnapshot(
  ownerId: string,
  projectId: string,
): Promise<GenerationSnapshot | null> {
  const [project] = await getDb()
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerId, ownerId)))
    .limit(1);

  if (!project) {
    return null;
  }

  return getGenerationSnapshot(projectId);
}

export async function getGenerationSnapshot(
  projectId: string,
): Promise<GenerationSnapshot> {
  const [job] = await getDb()
    .select()
    .from(generationJobs)
    .where(eq(generationJobs.projectId, projectId))
    .orderBy(desc(generationJobs.createdAt))
    .limit(1);

  if (!job) return emptySnapshot();

  return getSnapshotForJob(job);
}

export async function getGenerationSnapshotForJob(
  jobId: string,
): Promise<GenerationSnapshot> {
  const [job] = await getDb()
    .select()
    .from(generationJobs)
    .where(eq(generationJobs.id, jobId))
    .limit(1);

  if (!job) return emptySnapshot();

  return getSnapshotForJob(job);
}

async function getSnapshotForJob(job: GenerationJob): Promise<GenerationSnapshot> {

  const events = await getDb()
    .select()
    .from(generationEvents)
    .where(eq(generationEvents.jobId, job.id))
    .orderBy(asc(generationEvents.sequence));
  const [project] = await getDb()
    .select({ activeArtifactVersionId: projects.activeArtifactVersionId })
    .from(projects)
    .where(eq(projects.id, job.projectId))
    .limit(1);
  const [artifactVersion] = project?.activeArtifactVersionId
    ? await getDb()
        .select()
        .from(artifactVersions)
        .where(eq(artifactVersions.id, project.activeArtifactVersionId))
        .limit(1)
    : [];
  const versions = await getDb()
    .select()
    .from(artifactVersions)
    .where(eq(artifactVersions.projectId, job.projectId))
    .orderBy(desc(artifactVersions.version));

  return serializeSnapshot(job, events, artifactVersion, versions);
}

function emptySnapshot(): GenerationSnapshot {
  return { artifactVersion: null, events: [], job: null, versions: [] };
}

export async function getGenerationInputForJob(jobId: string): Promise<GenerationInput> {
  const [job] = await getDb()
    .select({
      baseVersionId: generationJobs.baseVersionId,
      buildRequest: buildRequests.content,
    })
    .from(generationJobs)
    .innerJoin(buildRequests, eq(generationJobs.buildRequestId, buildRequests.id))
    .where(eq(generationJobs.id, jobId))
    .limit(1);

  if (!job) {
    throw new Error("Generation job not found.");
  }

  let baseArtifact: BaseArtifact | null = null;
  if (job.baseVersionId) {
    const [artifact] = await getDb()
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.id, job.baseVersionId))
      .limit(1);
    if (!artifact) throw new Error("Base Version not found.");
    baseArtifact = {
      files: validateArtifact(artifact.files),
      id: artifact.id,
      version: artifact.version,
    };
  }

  return { baseArtifact, buildRequest: job.buildRequest };
}

export async function updateGenerationStatus(
  jobId: string,
  expectedStatus: ActiveGenerationStage,
  status: ActiveGenerationStage,
  message: string,
): Promise<boolean> {
  return getDb().transaction(async (transaction) => {
    const [job] = await transaction
      .select({ projectId: generationJobs.projectId })
      .from(generationJobs)
      .where(eq(generationJobs.id, jobId))
      .limit(1);
    if (!job) return false;

    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtext(${job.projectId}))`,
    );
    const [updated] = await transaction
      .update(generationJobs)
      .set({ status, updatedAt: new Date() })
      .where(
        and(
          eq(generationJobs.id, jobId),
          eq(generationJobs.status, expectedStatus),
        ),
      )
      .returning({ id: generationJobs.id });
    if (!updated) return false;

    const [lastEvent] = await transaction
      .select({ sequence: generationEvents.sequence })
      .from(generationEvents)
      .where(eq(generationEvents.jobId, jobId))
      .orderBy(desc(generationEvents.sequence))
      .limit(1);
    await transaction.insert(generationEvents).values({
      jobId,
      message,
      sequence: (lastEvent?.sequence ?? 0) + 1,
      stage: status,
    });
    return true;
  });
}

export async function claimGenerationJob(jobId: string): Promise<boolean> {
  return updateGenerationStatus(
    jobId,
    "queued",
    "planning",
    "Planning the constrained artifact.",
  );
}

export async function completeGenerationJob(
  jobId: string,
  projectId: string,
  files: ArtifactFiles,
): Promise<ArtifactVersion | null> {
  const validatedFiles = validateArtifact(files);
  return getDb().transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtext(${projectId}))`,
    );
    const [job] = await transaction
      .select({ status: generationJobs.status })
      .from(generationJobs)
      .where(eq(generationJobs.id, jobId))
      .limit(1);
    if (!job || job.status !== "validating") {
      return null;
    }

    const [previousVersion] = await transaction
      .select({ version: artifactVersions.version })
      .from(artifactVersions)
      .where(eq(artifactVersions.projectId, projectId))
      .orderBy(desc(artifactVersions.version))
      .limit(1);
    const version = (previousVersion?.version ?? 0) + 1;
    const [artifactVersion] = await transaction
      .insert(artifactVersions)
      .values({
        projectId,
        jobId,
        version,
        files: validatedFiles,
      })
      .returning();

    const [lastEvent] = await transaction
      .select({ sequence: generationEvents.sequence })
      .from(generationEvents)
      .where(eq(generationEvents.jobId, jobId))
      .orderBy(desc(generationEvents.sequence))
      .limit(1);
    await transaction.insert(generationEvents).values({
      jobId,
      sequence: (lastEvent?.sequence ?? 0) + 1,
      stage: "completed",
      message: `Version ${version} is ready in Preview.`,
    });
    await transaction
      .update(generationJobs)
      .set({
        completedAt: new Date(),
        status: "completed",
        updatedAt: new Date(),
      })
      .where(eq(generationJobs.id, jobId));
    await transaction
      .update(projects)
      .set({ activeArtifactVersionId: artifactVersion.id, updatedAt: new Date() })
      .where(eq(projects.id, projectId));

    return artifactVersion;
  });
}

export async function failGenerationJob(
  jobId: string,
  message: string,
  detail?: string,
): Promise<void> {
  await getDb().transaction(async (transaction) => {
    const [job] = await transaction
      .select({ projectId: generationJobs.projectId })
      .from(generationJobs)
      .where(eq(generationJobs.id, jobId))
      .limit(1);
    if (!job) return;

    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtext(${job.projectId}))`,
    );
    const [updated] = await transaction
      .update(generationJobs)
      .set({ errorMessage: message, status: "failed", updatedAt: new Date() })
      .where(
        and(
          eq(generationJobs.id, jobId),
          inArray(generationJobs.status, [...ACTIVE_GENERATION_STATUSES]),
        ),
      )
      .returning({ id: generationJobs.id });
    if (!updated) return;

    const [lastEvent] = await transaction
      .select({ sequence: generationEvents.sequence })
      .from(generationEvents)
      .where(eq(generationEvents.jobId, jobId))
      .orderBy(desc(generationEvents.sequence))
      .limit(1);
    const safeDetail = detail
      ?.replace(/[\r\n\t]+/g, " ")
      .replace(/"[^"]*"/g, '"[redacted]"')
      .slice(0, 640)
      .trim();
    await transaction.insert(generationEvents).values({
      jobId,
      message:
        message === "artifact_invalid" && safeDetail
          ? `Artifact rejected: ${safeDetail}`
          : message,
      sequence: (lastEvent?.sequence ?? 0) + 1,
      stage: "failed",
    });
  });
}

export async function cancelOwnedGeneration(
  ownerId: string,
  projectId: string,
): Promise<boolean | null> {
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
      return null;
    }

    const [job] = await transaction
      .select({ id: generationJobs.id })
      .from(generationJobs)
      .where(
        and(
          eq(generationJobs.projectId, projectId),
          inArray(generationJobs.status, [...ACTIVE_GENERATION_STATUSES]),
        ),
      )
      .orderBy(desc(generationJobs.createdAt))
      .limit(1);
    if (!job) {
      return false;
    }

    const [updated] = await transaction
      .update(generationJobs)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(
        and(
          eq(generationJobs.id, job.id),
          inArray(generationJobs.status, [...ACTIVE_GENERATION_STATUSES]),
        ),
      )
      .returning({ id: generationJobs.id });
    if (!updated) {
      return false;
    }

    const [lastEvent] = await transaction
      .select({ sequence: generationEvents.sequence })
      .from(generationEvents)
      .where(eq(generationEvents.jobId, job.id))
      .orderBy(desc(generationEvents.sequence))
      .limit(1);
    await transaction.insert(generationEvents).values({
      jobId: job.id,
      message: "Generation cancelled.",
      sequence: (lastEvent?.sequence ?? 0) + 1,
      stage: "cancelled",
    });
    return true;
  });
}

function serializeSnapshot(
  job: GenerationJob,
  events: GenerationEvent[],
  artifactVersion: ArtifactVersion | undefined,
  versions: ArtifactVersion[],
): GenerationSnapshot {
  return {
    artifactVersion: artifactVersion
      ? {
          createdAt: artifactVersion.createdAt.toISOString(),
          files: validateArtifact(artifactVersion.files),
          id: artifactVersion.id,
          version: artifactVersion.version,
        }
      : null,
    events: events.map((event) => ({
      createdAt: event.createdAt.toISOString(),
      id: event.id,
      message: event.message,
      sequence: event.sequence,
      stage: event.stage,
    })),
    job: {
      completedAt: job.completedAt?.toISOString() ?? null,
      createdAt: job.createdAt.toISOString(),
      errorMessage: job.errorMessage,
      id: job.id,
      projectId: job.projectId,
      buildRequestId: job.buildRequestId,
      baseVersionId: job.baseVersionId,
      status: job.status,
      updatedAt: job.updatedAt.toISOString(),
    },
    versions: versions.map((version) => ({
      createdAt: version.createdAt.toISOString(),
      id: version.id,
      version: version.version,
    })),
  };
}

export async function listOwnedArtifactVersions(
  ownerId: string,
  projectId: string,
): Promise<Array<Pick<ArtifactVersion, "id" | "version" | "createdAt">> | null> {
  const [project] = await getDb()
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerId, ownerId)))
    .limit(1);
  if (!project) return null;
  return getDb()
    .select({ id: artifactVersions.id, version: artifactVersions.version, createdAt: artifactVersions.createdAt })
    .from(artifactVersions)
    .where(eq(artifactVersions.projectId, projectId))
    .orderBy(desc(artifactVersions.version));
}

export async function getOwnedArtifactVersion(
  ownerId: string,
  projectId: string,
  versionId: string,
): Promise<ArtifactVersion | null> {
  const [version] = await getDb()
    .select({ artifact: artifactVersions })
    .from(artifactVersions)
    .innerJoin(projects, eq(artifactVersions.projectId, projects.id))
    .where(and(
      eq(artifactVersions.id, versionId),
      eq(artifactVersions.projectId, projectId),
      eq(projects.ownerId, ownerId),
    ))
    .limit(1);
  return version?.artifact ?? null;
}

export async function restoreOwnedArtifactVersion(
  ownerId: string,
  projectId: string,
  versionId: string,
): Promise<ArtifactVersion | null> {
  return getDb().transaction(async (transaction) => {
    const [version] = await transaction
      .select({ artifact: artifactVersions })
      .from(artifactVersions)
      .innerJoin(projects, eq(artifactVersions.projectId, projects.id))
      .where(and(
        eq(artifactVersions.id, versionId),
        eq(artifactVersions.projectId, projectId),
        eq(projects.ownerId, ownerId),
      ))
      .limit(1);
    if (!version) return null;
    await transaction
      .update(projects)
      .set({ activeArtifactVersionId: version.artifact.id, updatedAt: new Date() })
      .where(eq(projects.id, projectId));
    return version.artifact;
  });
}
