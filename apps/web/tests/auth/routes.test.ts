import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  cookies: vi.fn(),
  headers: vi.fn(),
}));
vi.mock("@/lib/auth/login", () => ({
  authenticateUser: vi.fn(),
  INVALID_LOGIN_MESSAGE: "Invalid username or password.",
}));
vi.mock("@/lib/auth/session", () => ({
  createSession: vi.fn(),
  createSessionCookieOptions: vi.fn(() => ({
    httpOnly: true,
    maxAge: 604_800,
    path: "/",
    sameSite: "lax",
    secure: true,
  })),
  deleteSession: vi.fn(),
  SESSION_COOKIE: "min_atoms_session",
}));

import { cookies, headers } from "next/headers";

import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { authenticateUser } from "@/lib/auth/login";
import { resetLoginRateLimitForTests } from "@/lib/auth/rate-limit";
import {
  createSession,
  createSessionCookieOptions,
  deleteSession,
} from "@/lib/auth/session";

const mockedAuthenticateUser = vi.mocked(authenticateUser);
const mockedCreateSession = vi.mocked(createSession);
const mockedCreateSessionCookieOptions = vi.mocked(createSessionCookieOptions);
const mockedDeleteSession = vi.mocked(deleteSession);
const mockedHeaders = vi.mocked(headers);
const mockedCookies = vi.mocked(cookies);

function loginRequest(username: string, password = "not-the-password") {
  return new Request("http://localhost/api/auth/login", {
    body: JSON.stringify({ password, username }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetLoginRateLimitForTests();
  mockedHeaders.mockResolvedValue(new Headers({ "x-real-ip": "203.0.113.10" }));
  mockedCookies.mockResolvedValue({ get: vi.fn() } as never);
});

describe("authentication route behavior", () => {
  it("returns the same generic failure for an unknown username and a wrong password", async () => {
    mockedAuthenticateUser.mockResolvedValue(null);

    const unknownUsername = await login(loginRequest("not-a-user"));
    const wrongPassword = await login(loginRequest("demo", "wrong-password"));

    expect(unknownUsername.status).toBe(401);
    expect(wrongPassword.status).toBe(401);
    await expect(unknownUsername.json()).resolves.toEqual({
      error: "Invalid username or password.",
    });
    await expect(wrongPassword.json()).resolves.toEqual({
      error: "Invalid username or password.",
    });
  });

  it("creates a secure browser session cookie only after a successful login", async () => {
    mockedAuthenticateUser.mockResolvedValue({
      createdAt: new Date("2026-07-26T00:00:00.000Z"),
      id: "user-1",
      passwordHash: "bcrypt-hash-is-never-returned",
      username: "demo",
    });
    mockedCreateSession.mockResolvedValue("opaque-session-token");

    const response = await login(loginRequest("demo", "correct-password"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ username: "demo" });
    expect(mockedCreateSession).toHaveBeenCalledWith("user-1");
    expect(mockedCreateSessionCookieOptions).toHaveBeenCalledOnce();
    expect(response.headers.get("set-cookie")).toContain("min_atoms_session=opaque-session-token");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("Secure");
    expect(response.headers.get("set-cookie")).toContain("SameSite=lax");
    expect(response.headers.get("set-cookie")).toContain("Path=/");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=604800");
  });

  it("deletes the server session and clears the browser cookie on logout", async () => {
    const get = vi.fn().mockReturnValue({ value: "opaque-session-token" });
    mockedCookies.mockResolvedValue({ get } as never);

    const response = await logout();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mockedDeleteSession).toHaveBeenCalledWith("opaque-session-token");
    expect(response.headers.get("set-cookie")).toContain("min_atoms_session=");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=lax");
    expect(response.headers.get("set-cookie")).toContain("Path=/");
  });

  it("returns 429 after repeated invalid login attempts from one address", async () => {
    mockedAuthenticateUser.mockResolvedValue(null);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await login(loginRequest("demo"));
      expect(response.status).toBe(401);
    }

    const blocked = await login(loginRequest("demo"));

    expect(blocked.status).toBe(429);
    await expect(blocked.json()).resolves.toEqual({
      error: "Invalid username or password.",
    });
    expect(mockedAuthenticateUser).toHaveBeenCalledTimes(5);
  });
});
