import { after, NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth/session";
import { requestConversationReply } from "@/lib/generation/deepseek";
import { getOwnedGenerationSnapshot } from "@/lib/generation/repository";
import { runGenerationJob } from "@/lib/generation/worker";
import {
  appendOwnedAssistantMessage,
  appendOwnedChatUserMessage,
  getOwnedProjectMessages,
} from "@/lib/projects/messages";
import { createOwnedFollowUpGeneration } from "@/lib/projects/repository";

export const maxDuration = 120;

const messageSchema = z.discriminatedUnion("mode", [
  z.object({
    content: z.string().max(20_000),
    mode: z.literal("chat"),
  }),
  z.object({
    baseVersionId: z.string().uuid(),
    content: z.string().max(20_000),
    mode: z.literal("build"),
  }),
]);

type RouteContext = { params: Promise<{ projectId: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }
  const { projectId } = await context.params;
  const messages = await getOwnedProjectMessages(user.id, projectId);
  if (!messages) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }
  return NextResponse.json({ messages });
}

export async function POST(request: Request, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }
  const payload = messageSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!payload.success || !payload.data.content.trim()) {
    return NextResponse.json(
      { error: "Message cannot be empty." },
      { status: 400 },
    );
  }
  const { projectId } = await context.params;
  const content = payload.data.content.trim();

  if (payload.data.mode === "build") {
    try {
      const created = await createOwnedFollowUpGeneration(
        user.id,
        projectId,
        content,
        payload.data.baseVersionId,
      );
      if (!created) {
        return NextResponse.json(
          { error: "Project not found." },
          { status: 404 },
        );
      }
      after(() => runGenerationJob(created.job.id));
      const [generation, messages] = await Promise.all([
        getOwnedGenerationSnapshot(user.id, projectId),
        getOwnedProjectMessages(user.id, projectId),
      ]);
      return NextResponse.json({ generation, messages }, { status: 202 });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "Base Version not found."
      ) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      throw error;
    }
  }

  const userMessage = await appendOwnedChatUserMessage(
    user.id,
    projectId,
    content,
  );
  if (!userMessage) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }
  const conversation = await getOwnedProjectMessages(user.id, projectId);
  if (!conversation) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }

  try {
    const reply = await requestConversationReply(conversation);
    await appendOwnedAssistantMessage(
      user.id,
      projectId,
      reply,
      "chat",
    );
    const messages = await getOwnedProjectMessages(user.id, projectId);
    return NextResponse.json({ messages });
  } catch (error) {
    const messages = await getOwnedProjectMessages(user.id, projectId);
    const detail =
      error instanceof Error && error.message.startsWith("provider_")
        ? "The AI provider could not return a conversation reply."
        : "The conversation reply failed.";
    return NextResponse.json({ error: detail, messages }, { status: 502 });
  }
}
