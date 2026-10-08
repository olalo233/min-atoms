import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { isUuid, jsonError, managerFailure, notFound, unauthorized } from "@/lib/server/http";
import { getManagerClient, MANAGER_TIMEOUTS, ManagerError } from "@/lib/server/manager";
import { findOwnedProject, versionBelongsToProject } from "@/lib/server/projects";

// Restore waits for the manager to commit the new version synchronously.
export const maxDuration = 60;

type RouteContext = { params: Promise<{ id: string; versionId: string }> };

export async function POST(_request: Request, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return unauthorized();
  }

  const { id, versionId } = await context.params;
  if (!isUuid(id) || !isUuid(versionId)) {
    return notFound("Version");
  }

  const project = await findOwnedProject(id, user.id);
  if (!project) {
    return notFound("Version");
  }

  if (!(await versionBelongsToProject(id, versionId))) {
    return notFound("Version");
  }

  try {
    const version = await getManagerClient().restore(id, versionId, MANAGER_TIMEOUTS.restore);
    return NextResponse.json(version);
  } catch (error) {
    // A run in progress or queued: architecture.md §8 requires 409.
    if (error instanceof ManagerError && error.status === 409) {
      return jsonError(409, "Stop the running build before restoring a version.");
    }
    return managerFailure(error);
  }
}
