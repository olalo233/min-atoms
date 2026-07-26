import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { listOwnedArtifactVersions } from "@/lib/generation/repository";

type RouteContext = { params: Promise<{ projectId: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { projectId } = await context.params;
  const versions = await listOwnedArtifactVersions(user.id, projectId);
  if (!versions) return NextResponse.json({ error: "Project not found." }, { status: 404 });
  return NextResponse.json({ versions });
}
