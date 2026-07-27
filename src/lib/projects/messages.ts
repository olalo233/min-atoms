import { and, asc, desc, eq, sql } from "drizzle-orm";

import {
  projectMessages,
  projects,
  type ProjectMessage,
} from "@/db/schema";
import { getDb } from "@/lib/db/client";
import type {
  ConversationMode,
  ProjectMessageSnapshot,
} from "@/lib/generation/types";

function serializeMessage(message: ProjectMessage): ProjectMessageSnapshot {
  return {
    artifactVersionId: message.artifactVersionId,
    buildRequestId: message.buildRequestId,
    content: message.content,
    createdAt: message.createdAt.toISOString(),
    id: message.id,
    mode: message.mode,
    role: message.role,
    sequence: message.sequence,
  };
}

export async function getOwnedProjectMessages(
  ownerId: string,
  projectId: string,
): Promise<ProjectMessageSnapshot[] | null> {
  const [ownedProject] = await getDb()
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerId, ownerId)))
    .limit(1);
  if (!ownedProject) return null;

  const messages = await getDb()
    .select()
    .from(projectMessages)
    .where(eq(projectMessages.projectId, projectId))
    .orderBy(asc(projectMessages.sequence));
  return messages.map(serializeMessage);
}

async function appendOwnedMessage(
  ownerId: string,
  projectId: string,
  values: {
    artifactVersionId?: string;
    buildRequestId?: string;
    content: string;
    mode: ConversationMode;
    role: "user" | "assistant";
  },
): Promise<ProjectMessageSnapshot | null> {
  return getDb().transaction(async (transaction) => {
    const [ownedProject] = await transaction
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.ownerId, ownerId)))
      .limit(1);
    if (!ownedProject) return null;

    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtext(${projectId}))`,
    );
    const [lastMessage] = await transaction
      .select({ sequence: projectMessages.sequence })
      .from(projectMessages)
      .where(eq(projectMessages.projectId, projectId))
      .orderBy(desc(projectMessages.sequence))
      .limit(1);
    const [message] = await transaction
      .insert(projectMessages)
      .values({
        ...values,
        projectId,
        sequence: (lastMessage?.sequence ?? 0) + 1,
      })
      .returning();
    await transaction
      .update(projects)
      .set({ updatedAt: new Date() })
      .where(eq(projects.id, projectId));
    return serializeMessage(message);
  });
}

export function appendOwnedChatUserMessage(
  ownerId: string,
  projectId: string,
  content: string,
) {
  return appendOwnedMessage(ownerId, projectId, {
    content,
    mode: "chat",
    role: "user",
  });
}

export function appendOwnedAssistantMessage(
  ownerId: string,
  projectId: string,
  content: string,
  mode: ConversationMode,
) {
  return appendOwnedMessage(ownerId, projectId, {
    content,
    mode,
    role: "assistant",
  });
}
