import { and, asc, desc, eq, sql } from "drizzle-orm";

import {
  artifactVersions,
  buildRequests,
  generationJobs,
  projects,
  type ArtifactVersion,
  type BuildRequest,
  type GenerationJob,
  type Project,
} from "@/db/schema";
import { getDb } from "@/lib/db/client";

export type OwnedProjectPageSeed = {
  artifactVersion: ArtifactVersion | null;
  buildRequest: BuildRequest;
  job: GenerationJob | null;
  project: Project;
};

/**
 * The authorization fence for the project page. It deliberately returns the
 * latest job and active artifact with the owned project so downstream streamed
 * reads do not repeat the same ownership query.
 */
export async function getOwnedProjectPageSeed(
  ownerId: string,
  projectId: string,
): Promise<OwnedProjectPageSeed | null> {
  const database = getDb();
  const initialBuildRequest = database
    .select()
    .from(buildRequests)
    .where(eq(buildRequests.projectId, projects.id))
    .orderBy(asc(buildRequests.createdAt))
    .limit(1)
    .as("initial_build_request");
  const latestJob = database
    .select()
    .from(generationJobs)
    .where(eq(generationJobs.projectId, projects.id))
    .orderBy(desc(generationJobs.createdAt))
    .limit(1)
    .as("latest_generation_job");

  const [seed] = await database
    .select({
      artifactVersion: artifactVersions,
      buildRequest: {
        baseVersionId: initialBuildRequest.baseVersionId,
        content: initialBuildRequest.content,
        createdAt: initialBuildRequest.createdAt,
        id: initialBuildRequest.id,
        projectId: initialBuildRequest.projectId,
      },
      job: {
        baseVersionId: latestJob.baseVersionId,
        buildRequestId: latestJob.buildRequestId,
        completedAt: latestJob.completedAt,
        createdAt: latestJob.createdAt,
        errorMessage: latestJob.errorMessage,
        id: latestJob.id,
        projectId: latestJob.projectId,
        status: latestJob.status,
        updatedAt: latestJob.updatedAt,
      },
      project: projects,
    })
    .from(projects)
    .innerJoinLateral(initialBuildRequest, sql`true`)
    .leftJoinLateral(latestJob, sql`true`)
    .leftJoin(
      artifactVersions,
      eq(projects.activeArtifactVersionId, artifactVersions.id),
    )
    .where(and(eq(projects.ownerId, ownerId), eq(projects.id, projectId)))
    .limit(1);

  return seed ?? null;
}
