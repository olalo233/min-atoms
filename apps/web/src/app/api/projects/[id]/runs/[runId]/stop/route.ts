import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { isUuid, managerFailure, notFound, unauthorized } from "@/lib/server/http";
import { getManagerClient, MANAGER_TIMEOUTS } from "@/lib/server/manager";
import { findOwnedProject, runBelongsToProject } from "@/lib/server/projects";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string; runId: string }> };

export async function POST(_request: Request, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return unauthorized();
  }

  const { id, runId } = await context.params;
  if (!isUuid(id) || !isUuid(runId)) {
    return notFound("Run");
  }

  const project = await findOwnedProject(id, user.id);
  if (!project) {
    return notFound("Run");
  }

  // The run must belong to this project, so no owner can abort another project's run.
  if (!(await runBelongsToProject(id, runId))) {
    return notFound("Run");
  }

  try {
    await getManagerClient().abort(id, runId, MANAGER_TIMEOUTS.abort);
  } catch (error) {
    return managerFailure(error);
  }

  return NextResponse.json({});
}
