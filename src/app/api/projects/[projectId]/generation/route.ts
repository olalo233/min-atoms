import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import {
  cancelOwnedGeneration,
  getOwnedGenerationSnapshot,
} from "@/lib/generation/repository";
import { runGenerationJob } from "@/lib/generation/worker";
import { retryOwnedGeneration } from "@/lib/projects/repository";

export const maxDuration = 120;

type GenerationRouteContext = {
  params: Promise<{ projectId: string }>;
};

export async function GET(
  _request: Request,
  context: GenerationRouteContext,
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

  return NextResponse.json(snapshot);
}

export async function POST(
  _request: Request,
  context: GenerationRouteContext,
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }

  const { projectId } = await context.params;
  const job = await retryOwnedGeneration(user.id, projectId);
  if (!job) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }
  await runGenerationJob(job.id);
  const snapshot = await getOwnedGenerationSnapshot(user.id, projectId);
  return NextResponse.json(snapshot, { status: 202 });
}

export async function DELETE(
  _request: Request,
  context: GenerationRouteContext,
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }

  const { projectId } = await context.params;
  const cancelled = await cancelOwnedGeneration(user.id, projectId);
  if (cancelled === null) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }
  const snapshot = await getOwnedGenerationSnapshot(user.id, projectId);
  return NextResponse.json(snapshot);
}
