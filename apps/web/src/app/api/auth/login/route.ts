import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { authenticateUser, INVALID_LOGIN_MESSAGE } from "@/lib/auth/login";
import {
  clearLoginFailures,
  isLoginRateLimited,
  recordLoginFailure,
} from "@/lib/auth/rate-limit";
import {
  createSession,
  createSessionCookieOptions,
  SESSION_COOKIE,
} from "@/lib/auth/session";

const loginSchema = z.object({
  username: z.string().trim().min(1).max(120),
  password: z.string().min(1).max(256),
});

function genericError(status: number) {
  return NextResponse.json({ error: INVALID_LOGIN_MESSAGE }, { status });
}

export async function POST(request: Request) {
  const requestHeaders = await headers();
  const ip = requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? requestHeaders.get("x-real-ip")
    ?? "unknown";

  if (isLoginRateLimited(ip)) {
    return genericError(429);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    recordLoginFailure(ip);
    return genericError(401);
  }

  const parsed = loginSchema.safeParse(payload);
  if (!parsed.success) {
    recordLoginFailure(ip);
    return genericError(401);
  }

  const user = await authenticateUser(parsed.data.username, parsed.data.password);
  if (!user) {
    recordLoginFailure(ip);
    return genericError(401);
  }

  clearLoginFailures(ip);
  const token = await createSession(user.id);
  const response = NextResponse.json({ username: user.username });
  response.cookies.set(SESSION_COOKIE, token, createSessionCookieOptions());
  return response;
}
