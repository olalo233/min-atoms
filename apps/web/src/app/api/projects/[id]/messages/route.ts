import { checkUserInput } from "@/lib/server/input-safety";
import { getManagerClient, MANAGER_TIMEOUTS } from "@/lib/server/manager";
import { accountSuspended } from "@/lib/server/http";
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
  if (user.suspendedAt) return accountSuspended();

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

  const rejection = await checkUserInput(user.id, {
    kind: "message", content: parsed.data.content, annotation: parsed.data.annotation,
  }, id);
  if (rejection) return rejection;

  const result = await appendUserMessageAndRun({
    projectId: id,
    content: parsed.data.content,
    mode: parsed.data.mode,
    annotation: parsed.data.annotation,
    steer: (runId, messageId) => getManagerClient().steer(id, runId, {
      messageId, content: parsed.data.content, annotation: parsed.data.annotation,
    }, MANAGER_TIMEOUTS.steer),
  });

  if (!result.steered) scheduleKick(id, project.previewLabel);
  return NextResponse.json(result, { status: 201 });
}
