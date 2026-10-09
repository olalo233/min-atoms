import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { getDb, execute } = vi.hoisted(() => ({
  getDb: vi.fn(),
  execute: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ getDb }));

import { dynamic, GET } from "@/app/api/cron/keepalive/route";
import vercelConfig from "../../vercel.json";

const secret = "fake-cron-secret";

function request(authorization?: string) {
  const headers = new Headers({ cookie: "session=fake-browser-session" });
  if (authorization !== undefined) headers.set("authorization", authorization);
  return new Request("http://localhost/api/cron/keepalive", { headers });
}

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", secret);
  getDb.mockReset().mockReturnValue({ execute });
  execute.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/cron/keepalive", () => {
  test.each([undefined, "Bearer wrong-secret", secret])(
    "rejects unauthorized header %s without accessing the database",
    async (authorization) => {
      const response = await GET(request(authorization));

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "Unauthorized" });
      expect(getDb).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    },
  );

  test.each([undefined, ""])(
    "rejects an unconfigured server secret %s without accessing the database",
    async (serverSecret) => {
      vi.stubEnv("CRON_SECRET", serverSecret);
      const response = await GET(request(`Bearer ${serverSecret}`));

      expect(response.status).toBe(401);
      expect(getDb).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    },
  );

  test("awaits one read-only query before returning an uncached success", async () => {
    let completeQuery!: () => void;
    execute.mockReturnValue(new Promise<void>((resolve) => { completeQuery = resolve; }));
    let responded = false;
    const pendingResponse = GET(request(`Bearer ${secret}`)).then((response) => {
      responded = true;
      return response;
    });

    await Promise.resolve();
    expect(responded).toBe(false);
    expect(getDb).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(new PgDialect().sqlToQuery(execute.mock.calls[0][0])).toMatchObject({
      sql: "SELECT 1",
      params: [],
    });

    completeQuery();
    const response = await pendingResponse;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(dynamic).toBe("force-dynamic");
  });

  test("returns a generic failure when the query fails", async () => {
    execute.mockRejectedValue(new Error("private database failure details"));
    const response = await GET(request(`Bearer ${secret}`));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Service unavailable" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test("returns a generic failure when opening the database fails", async () => {
    getDb.mockImplementation(() => { throw new Error("private configuration details"); });
    const response = await GET(request(`Bearer ${secret}`));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Service unavailable" });
    expect(execute).not.toHaveBeenCalled();
  });
});

test("Vercel schedules only the daily keepalive and preserves deployment settings", () => {
  expect(vercelConfig).toEqual({
    $schema: "https://openapi.vercel.sh/vercel.json",
    regions: ["hnd1"],
    crons: [{ path: "/api/cron/keepalive", schedule: "0 5 * * *" }],
  });
});
