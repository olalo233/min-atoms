import { signSseToken } from "@min-atoms/protocol";
import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { isUuid, jsonError, notFound, unauthorized } from "@/lib/server/http";
import { getManagerClient, ManagerError } from "@/lib/server/manager";
import { previewUrlForLabel } from "@/lib/server/preview";
import { findOwnedProject } from "@/lib/server/projects";

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

  const project = await findOwnedProject(id, user.id);
  if (!project) {
    return notFound("Project");
  }

  const secret = process.env.MA_SHARED_SECRET;
  if (!secret) {
    return jsonError(502, "The demo environment is unavailable.");
  }

  // The browser subscribes to the manager's SSE stream with this short-lived token.
  const token = await signSseToken(id, secret);
  try {
    return NextResponse.json({
      token,
      streamUrl: getManagerClient().streamUrl(id, token),
      previewUrl: previewUrlForLabel(project.previewLabel),
    });
  } catch (error) {
    if (error instanceof ManagerError) {
      return jsonError(502, "The demo environment is unavailable.");
    }
    throw error;
  }
}
