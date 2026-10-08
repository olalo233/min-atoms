import { WebCreateMessageRequestSchema } from "@min-atoms/protocol";
import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { isUuid, jsonError, notFound, unauthorized } from "@/lib/server/http";
import { scheduleKick } from "@/lib/server/kick";
import { appendUserMessageAndRun, findOwnedProject } from "@/lib/server/projects";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return unauthorized();
  }

  const { id } = await context.params;
  if (!isUuid(id)) {
    return notFound("Project");
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return jsonError(400, "A JSON body with content and mode is required.");
  }

  const parsed = WebCreateMessageRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return jsonError(400, "A JSON body with content and mode is required.");
  }

  const project = await findOwnedProject(id, user.id);
  if (!project) {
    return notFound("Project");
  }

  // Writing the message and its queued run never touches the manager, so a
  // stopped VM still accepts messages; they start when the environment is back.
  const { message, run } = await appendUserMessageAndRun({
    projectId: id,
    content: parsed.data.content,
    mode: parsed.data.mode,
  });

  scheduleKick(id, project.previewLabel);
  return NextResponse.json({ message, run }, { status: 201 });
}
