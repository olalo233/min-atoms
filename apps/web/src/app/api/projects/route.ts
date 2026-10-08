import { WebCreateProjectRequestSchema, type ProjectSummary } from "@min-atoms/protocol";
import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { jsonError, unauthorized } from "@/lib/server/http";
import { scheduleKick } from "@/lib/server/kick";
import { createProjectWithRun, listProjectSummaries, PreviewHostUnavailableError } from "@/lib/server/projects";

export const dynamic = "force-dynamic";

const MAX_PROJECT_NAME_LENGTH = 24;

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return unauthorized();
  }

  const summaries: ProjectSummary[] = await listProjectSummaries(user.id);
  return NextResponse.json(summaries);
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return unauthorized();
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return jsonError(400, "Describe what you want to build.");
  }

  const parsed = WebCreateProjectRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return jsonError(400, "Describe what you want to build.");
  }

  const prompt = parsed.data.prompt.trim();
  if (!prompt) {
    return jsonError(400, "Describe what you want to build.");
  }
  const name = prompt.replace(/\s+/g, " ").slice(0, MAX_PROJECT_NAME_LENGTH);

  let created: { id: string; previewLabel: string };
  try {
    created = await createProjectWithRun({ ownerId: user.id, name, prompt });
  } catch (error) {
    if (error instanceof PreviewHostUnavailableError) {
      return jsonError(503, "No preview host is available.");
    }
    throw error;
  }

  // Return immediately; the manager builds the queue while the browser navigates.
  scheduleKick(created.id, created.previewLabel);
  return NextResponse.json({ id: created.id }, { status: 201 });
}
