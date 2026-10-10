import { projects, screeningEvents, users } from "@min-atoms/db";
import { and, count, eq, gte } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { runAfterResponse } from "./after";
import { accountSuspended, safetyError } from "./http";
import { getManagerClient } from "./manager";
import { screenInput, ScreeningUnavailable, type ScreeningInput } from "./screening";

/** Returns an HTTP rejection, or null when the input may be written. */
export async function checkUserInput(userId: string, input: ScreeningInput, projectId?: string) {
  let result;
  try {
    result = await screenInput(input);
  } catch (error) {
    if (error instanceof ScreeningUnavailable) {
      return safetyError(503, "screening_unavailable", error.message);
    }
    throw error;
  }
  if (result.verdict === "allow") return null;

  const suspended = await getDb().transaction(async (tx) => {
    // Serialize strikes per account, without locking any other user's account.
    await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");
    await tx.insert(screeningEvents).values({
      userId, projectId, kind: input.kind, category: result.category,
      scores: result.scores, excerpt: input.content.slice(0, 200),
    });
    const now = new Date();
    const [strikes] = await tx.select({ total: count() }).from(screeningEvents).where(and(
      eq(screeningEvents.userId, userId),
      gte(screeningEvents.createdAt, new Date(now.getTime() - 24 * 60 * 60 * 1_000)),
    ));
    const configuredLimit = Number(process.env.MA_STRIKE_LIMIT ?? "3");
    const limit = Number.isInteger(configuredLimit) && configuredLimit > 0 ? configuredLimit : 3;
    if (strikes.total < limit) return false;
    await tx.update(users).set({ suspendedAt: now, suspendedReason: "repeated_input_violations" })
      .where(eq(users.id, userId));
    return true;
  });
  if (!suspended) return safetyError(422, "input_rejected", "这个请求涉及有害或平台滥用内容，请修改后再试");

  runAfterResponse(async () => {
    const owned = await getDb().select({ id: projects.id }).from(projects).where(eq(projects.ownerId, userId));
    // Attempt every project even if one manager call fails.
    const outcomes = await Promise.allSettled(owned.map((project) => getManagerClient().suspend(project.id)));
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") console.error("Manager suspension failed:", outcome.reason);
    }
  });
  return accountSuspended();
}
