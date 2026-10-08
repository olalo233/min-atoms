import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSessionCookieOptions,
  hashSessionToken,
  SESSION_DURATION_MS,
} from "@/lib/auth/session";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("session security", () => {
  it("stores only a keyed digest of the opaque session token", () => {
    vi.stubEnv("SESSION_SECRET", "test-only-session-secret");

    const token = "opaque-session-token";
    const digest = hashSessionToken(token);

    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).not.toContain(token);
    expect(hashSessionToken(token)).toBe(digest);
    expect(hashSessionToken("different-token")).not.toBe(digest);
  });

  it("uses an HttpOnly cookie with bounded lifetime and production-only Secure", () => {
    vi.stubEnv("NODE_ENV", "production");

    expect(createSessionCookieOptions()).toEqual({
      httpOnly: true,
      maxAge: SESSION_DURATION_MS / 1000,
      path: "/",
      sameSite: "lax",
      secure: true,
    });
  });
});
