import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth/session";
import { getOwnedGenerationSnapshot } from "@/lib/generation/repository";
import { createOwnedFollowUpGeneration } from "@/lib/projects/repository";
import { runGenerationJob } from "@/lib/generation/worker";

export const maxDuration = 120;

const followUpSchema = z.object({
  baseVersionId: z.string().uuid(),
  buildRequest: z.string().max(20_000),
});

type RouteContext = { params: Promise<{ projectId: string }> };

export async function POST(request: Request, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const payload = followUpSchema.safeParse(await request.json().catch(() => null));
  if (!payload.success || !payload.data.buildRequest.trim()) {
    return NextResponse.json({ error: "Build request cannot be empty." }, { status: 400 });
  }
  const { projectId } = await context.params;
  try {
    const created = await createOwnedFollowUpGeneration(
      user.id,
      projectId,
      payload.data.buildRequest,
      payload.data.baseVersionId,
    );
    if (!created) return NextResponse.json({ error: "Project not found." }, { status: 404 });
    await runGenerationJob(created.job.id);
    const snapshot = await getOwnedGenerationSnapshot(user.id, projectId);
    return NextResponse.json(snapshot, { status: 202 });
  } catch (error) {
    if (error instanceof Error && error.message === "Base Version not found.") {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}
