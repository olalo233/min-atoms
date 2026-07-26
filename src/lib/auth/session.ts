import { createHmac, randomBytes } from "node:crypto";

import { and, eq, gt } from "drizzle-orm";
import { cookies } from "next/headers";

import { sessions, users, type User } from "@/db/schema";
import { getDb } from "@/lib/db/client";

export const SESSION_COOKIE = "min_atoms_session";
export const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (secret) {
    return secret;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET is required in production.");
  }

  return "local-development-session-secret";
}

export function hashSessionToken(token: string): string {
  return createHmac("sha256", getSessionSecret()).update(token).digest("hex");
}

export function createSessionCookieOptions() {
  return {
    httpOnly: true,
    maxAge: SESSION_DURATION_MS / 1000,
    path: "/",
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
  };
}

export async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

  await getDb().insert(sessions).values({
    tokenHash: hashSessionToken(token),
    userId,
    expiresAt,
  });

  return token;
}

export async function getUserForSessionToken(
  token: string,
): Promise<User | null> {
  const result = await getDb()
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(
      and(
        eq(sessions.tokenHash, hashSessionToken(token)),
        gt(sessions.expiresAt, new Date()),
      ),
    )
    .limit(1);

  return result[0]?.user ?? null;
}

export async function getCurrentUser(): Promise<User | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) {
    return null;
  }

  return getUserForSessionToken(token);
}

export async function deleteSession(token: string): Promise<void> {
  await getDb()
    .delete(sessions)
    .where(eq(sessions.tokenHash, hashSessionToken(token)));
}
