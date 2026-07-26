import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { getOwnedGenerationSnapshot } from "@/lib/generation/repository";

type PreviewRouteContext = {
  params: Promise<{ projectId: string }>;
};

export async function GET(
  _request: Request,
  context: PreviewRouteContext,
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }

  const { projectId } = await context.params;
  const snapshot = await getOwnedGenerationSnapshot(user.id, projectId);
  if (!snapshot) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }
  if (!snapshot.artifactVersion) {
    return NextResponse.json(
      { error: "Preview is not ready yet." },
      { status: 404 },
    );
  }

  return NextResponse.json({
    artifactVersion: snapshot.artifactVersion,
  });
}
