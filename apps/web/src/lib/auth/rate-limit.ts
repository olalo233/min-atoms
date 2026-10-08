type LoginAttempt = {
  failures: number;
  windowStartedAt: number;
  blockedUntil?: number;
};

const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map<string, LoginAttempt>();

export function isLoginRateLimited(key: string, now = Date.now()): boolean {
  const attempt = attempts.get(key);
  if (!attempt) {
    return false;
  }

  if (attempt.blockedUntil && attempt.blockedUntil > now) {
    return true;
  }

  if (now - attempt.windowStartedAt >= WINDOW_MS) {
    attempts.delete(key);
  }

  return false;
}

export function recordLoginFailure(key: string, now = Date.now()): void {
  const current = attempts.get(key);
  const isCurrentWindow = current
    && now - current.windowStartedAt < WINDOW_MS;
  const failures = isCurrentWindow
    ? current.failures + 1
    : 1;
  const windowStartedAt = isCurrentWindow
    ? current.windowStartedAt
    : now;

  attempts.set(key, {
    failures,
    windowStartedAt,
    blockedUntil: failures >= MAX_FAILURES
      ? windowStartedAt + WINDOW_MS
      : undefined,
  });
}

export function clearLoginFailures(key: string): void {
  attempts.delete(key);
}

export function resetLoginRateLimitForTests(): void {
  attempts.clear();
}

export const loginRateLimit = {
  maxFailures: MAX_FAILURES,
  windowMs: WINDOW_MS,
};
