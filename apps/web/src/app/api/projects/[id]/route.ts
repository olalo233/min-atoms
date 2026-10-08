import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { isUuid, jsonError, managerFailure, notFound, unauthorized } from "@/lib/server/http";
import { getManagerClient, MANAGER_TIMEOUTS, ManagerError } from "@/lib/server/manager";
import { deleteOwnedProject, getProjectDetail, type DeleteProjectOutcome } from "@/lib/server/projects";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return unauthorized();
  }

  const { id } = await context.params;
  if (!isUuid(id)) {
    return notFound("Project");
  }

  const detail = await getProjectDetail(id, user.id);
  if (!detail) {
    return notFound("Project");
  }

  return NextResponse.json(detail);
}

export async function DELETE(_request: Request, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return unauthorized();
  }

  const { id } = await context.params;
  if (!isUuid(id)) {
    return notFound("Project");
  }

  // The owner check, the active-run check, the manager removal and the deletion
  // all run inside one transaction that holds the project row lock, so a message
  // writer can neither slip a queued run past the check nor lose one to the delete.
  let outcome: DeleteProjectOutcome;
  try {
    outcome = await deleteOwnedProject({
      projectId: id,
      ownerId: user.id,
      removeManager: async () => {
        try {
          await getManagerClient().removeProject(id, MANAGER_TIMEOUTS.removeProject);
        } catch (error) {
          // A manager that never heard of the project has nothing left to clean up.
          if (error instanceof ManagerError && error.status === 404) {
            return;
          }
          throw error;
        }
      },
    });
  } catch (error) {
    return managerFailure(error);
  }

  if (outcome === "not_found") {
    return notFound("Project");
  }
  if (outcome === "conflict") {
    return jsonError(409, "Stop the running build before deleting this project.");
  }

  return NextResponse.json({});
}
