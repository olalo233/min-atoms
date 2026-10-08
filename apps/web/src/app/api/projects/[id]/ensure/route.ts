import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { isUuid, managerFailure, notFound, unauthorized } from "@/lib/server/http";
import { kickProject } from "@/lib/server/kick";
import { getManagerClient, MANAGER_TIMEOUTS } from "@/lib/server/manager";
import { findOwnedProject, hasQueuedRun } from "@/lib/server/projects";

// ensure waits up to 60 s for the container to answer on :5173 (architecture.md §10).
export const maxDuration = 60;

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return unauthorized();
  }

  const { id } = await context.params;
  if (!isUuid(id)) {
    return notFound("Project");
  }

  const project = await findOwnedProject(id, user.id);
  if (!project) {
    return notFound("Project");
  }

  try {
    await getManagerClient().ensure(id, project.previewLabel, MANAGER_TIMEOUTS.ensure);
  } catch (error) {
    return managerFailure(error);
  }

  if (await hasQueuedRun(id)) {
    await kickProject(id, project.previewLabel);
  }

  return NextResponse.json({ ready: true });
}
