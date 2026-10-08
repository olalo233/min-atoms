import { beforeEach, describe, expect, it } from "vitest";

import {
  clearLoginFailures,
  isLoginRateLimited,
  loginRateLimit,
  recordLoginFailure,
  resetLoginRateLimitForTests,
} from "@/lib/auth/rate-limit";

describe("login rate limiting", () => {
  beforeEach(() => {
    resetLoginRateLimitForTests();
  });

  it("blocks repeated failures and clears after a successful login", () => {
    const now = 10_000;
    for (let attempt = 0; attempt < loginRateLimit.maxFailures; attempt += 1) {
      recordLoginFailure("127.0.0.1", now);
    }

    expect(isLoginRateLimited("127.0.0.1", now)).toBe(true);
    clearLoginFailures("127.0.0.1");
    expect(isLoginRateLimited("127.0.0.1", now)).toBe(false);
  });

  it("allows attempts again after the rate-limit window", () => {
    const now = 10_000;
    for (let attempt = 0; attempt < loginRateLimit.maxFailures; attempt += 1) {
      recordLoginFailure("127.0.0.1", now);
    }

    expect(isLoginRateLimited("127.0.0.1", now + loginRateLimit.windowMs + 1)).toBe(false);
  });

  it("uses one fixed window even when failures are spread across it", () => {
    const startedAt = 10_000;
    const spacing = Math.floor(loginRateLimit.windowMs / loginRateLimit.maxFailures);

    for (let attempt = 0; attempt < loginRateLimit.maxFailures; attempt += 1) {
      recordLoginFailure("127.0.0.2", startedAt + (attempt * spacing));
    }

    expect(isLoginRateLimited("127.0.0.2", startedAt + loginRateLimit.windowMs - 1))
      .toBe(true);
    expect(isLoginRateLimited("127.0.0.2", startedAt + loginRateLimit.windowMs + 1))
      .toBe(false);
  });
});
