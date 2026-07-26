import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { getOwnedGenerationSnapshot, restoreOwnedArtifactVersion } from "@/lib/generation/repository";

type RouteContext = { params: Promise<{ projectId: string; versionId: string }> };

export async function POST(_request: Request, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { projectId, versionId } = await context.params;
  const version = await restoreOwnedArtifactVersion(user.id, projectId, versionId);
  if (!version) return NextResponse.json({ error: "Artifact Version not found." }, { status: 404 });
  const snapshot = await getOwnedGenerationSnapshot(user.id, projectId);
  return NextResponse.json(snapshot);
}
