import { eq, sql, type ExtractTablesWithRelations } from "drizzle-orm";
import type { PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import * as schema from "./schema";
import { messages, projects } from "./schema";

export type NewMessage = Pick<typeof messages.$inferInsert, "role" | "mode" | "content" | "runId" | "versionId">;

// Must be called inside the caller's transaction. Locking the project serializes
// every message writer, including an empty conversation's first insertion.
export async function appendMessage<TResult extends PgQueryResultHKT>(
  tx: PgTransaction<TResult, typeof schema, ExtractTablesWithRelations<typeof schema>>,
  projectId: string,
  message: NewMessage,
) {
  const [project] = await tx.select({ id: projects.id }).from(projects)
    .where(eq(projects.id, projectId)).for("update");
  if (!project) throw new Error("Project does not exist.");

  const [next] = await tx.select({ seq: sql<number>`coalesce(max(${messages.seq}), 0) + 1`.mapWith(Number) })
    .from(messages).where(eq(messages.projectId, projectId));
  const [inserted] = await tx.insert(messages).values({
    ...message, projectId, seq: next.seq,
  }).returning();
  return inserted;
}
