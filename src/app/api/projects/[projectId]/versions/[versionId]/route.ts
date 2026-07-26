import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { getOwnedArtifactVersion } from "@/lib/generation/repository";
import { validateArtifact } from "@/lib/generation/validator";

type RouteContext = { params: Promise<{ projectId: string; versionId: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { projectId, versionId } = await context.params;
  const artifactVersion = await getOwnedArtifactVersion(user.id, projectId, versionId);
  if (!artifactVersion) return NextResponse.json({ error: "Artifact Version not found." }, { status: 404 });
  return NextResponse.json({
    artifactVersion: {
      createdAt: artifactVersion.createdAt.toISOString(),
      files: validateArtifact(artifactVersion.files),
      id: artifactVersion.id,
      version: artifactVersion.version,
    },
  });
}
