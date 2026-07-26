import { after, NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth/session";
import { runGenerationJob } from "@/lib/generation/worker";
import {
  createProjectWithBuildRequest,
  listOwnedProjects,
} from "@/lib/projects/repository";

export const maxDuration = 120;

const createProjectSchema = z.object({
  buildRequest: z.string().max(20_000),
});

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }

  const projects = await listOwnedProjects(user.id);
  return NextResponse.json({ projects });
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      { error: "A valid JSON body is required." },
      { status: 400 },
    );
  }

  const parsed = createProjectSchema.safeParse(payload);
  if (!parsed.success || !parsed.data.buildRequest.trim()) {
    return NextResponse.json(
      { error: "Build request cannot be empty." },
      { status: 400 },
    );
  }

  const result = await createProjectWithBuildRequest(
    user.id,
    parsed.data.buildRequest,
  );
  // Return immediately; the queued job is persisted, and the worker runs after
  // the response through `after()` so the serverless invocation stays alive.
  after(() => runGenerationJob(result.job.id));
  return NextResponse.json(
    { project: result.project, buildRequest: result.buildRequest },
    { status: 201 },
  );
}
