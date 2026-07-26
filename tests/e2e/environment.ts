const DEFAULT_DATABASE_URL =
  "postgresql://min_atoms:min_atoms@127.0.0.1:5432/min_atoms";

function getLocalDatabaseUrl() {
  const value = process.env.E2E_DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const url = new URL(value);
  const localHosts = new Set(["127.0.0.1", "::1", "localhost"]);

  if (url.protocol !== "postgresql:" || !localHosts.has(url.hostname)) {
    throw new Error(
      "E2E_DATABASE_URL must be a local PostgreSQL URL; browser acceptance never targets a remote database.",
    );
  }

  return value;
}

export function getE2eEnvironment(): Record<string, string> {
  return {
    DATABASE_URL: getLocalDatabaseUrl(),
    DEMO_PASSWORD: process.env.E2E_DEMO_PASSWORD ?? "min-atoms-demo",
    DEMO_USERNAME: process.env.E2E_DEMO_USERNAME ?? "demo",
    DETERMINISTIC_GENERATION_DELAY_MS: "1500",
    GENERATION_PROVIDER: "deterministic",
    SESSION_SECRET:
      process.env.E2E_SESSION_SECRET ??
      "local-e2e-session-secret-change-before-sharing-123456",
  };
}
