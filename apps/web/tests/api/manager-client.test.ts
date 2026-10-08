import { afterEach, describe, expect, test, vi } from "vitest";

import {
  getManagerClient,
  MANAGER_TIMEOUTS,
  ManagerClient,
  ManagerError,
  resetManagerClientForTests,
  type ManagerFetch,
} from "@/lib/server/manager";

const baseUrl = "https://ma-vm.expii.top";
const secret = "test-shared-secret";
const projectId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const versionId = "33333333-3333-4333-8333-333333333333";

function clientWith(fetchImpl: ManagerFetch) {
  return new ManagerClient({ baseUrl, secret, fetch: fetchImpl });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.useRealTimers();
  delete process.env.MANAGER_URL;
  delete process.env.MA_SHARED_SECRET;
  resetManagerClientForTests();
});

describe("manager client", () => {
  test("calls the documented routes with the shared bearer secret", async () => {
    const fetchImpl = vi.fn<ManagerFetch>(async (url) =>
      jsonResponse(url.endsWith("/ensure") ? { ready: true } : {}),
    );
    const client = clientWith(fetchImpl);

    await client.kick(projectId, "ma-k3x9q2ab");
    await client.ensure(projectId, "ma-k3x9q2ab");
    await client.abort(projectId, runId);
    await client.removeProject(projectId);

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      `${baseUrl}/projects/${projectId}/kick`,
      `${baseUrl}/projects/${projectId}/ensure`,
      `${baseUrl}/projects/${projectId}/runs/${runId}/abort`,
      `${baseUrl}/projects/${projectId}`,
    ]);

    const kickInit = fetchImpl.mock.calls[0][1];
    expect(kickInit.method).toBe("POST");
    expect(kickInit.headers).toMatchObject({ authorization: `Bearer ${secret}` });
    expect(JSON.parse(String(kickInit.body))).toEqual({ previewLabel: "ma-k3x9q2ab" });
    expect(fetchImpl.mock.calls[3][1].method).toBe("DELETE");
  });

  test("returns the version DTO the manager produced for a restore", async () => {
    const version = {
      id: versionId,
      projectId,
      number: 3,
      commitSha: "b".repeat(40),
      summary: "恢复到版本 1",
      runId: null,
      screenshot: true,
      createdAt: "2026-10-08T12:00:00.000Z",
    };
    const fetchImpl = vi.fn<ManagerFetch>(async () => jsonResponse(version));
    const client = clientWith(fetchImpl);

    await expect(client.restore(projectId, versionId)).resolves.toEqual(version);
    expect(fetchImpl.mock.calls[0][0]).toBe(`${baseUrl}/projects/${projectId}/restore`);
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1].body))).toEqual({ versionId });
  });

  test("surfaces the manager status so routes can keep 404 and 409 distinct", async () => {
    const conflict = clientWith(vi.fn(async () => jsonResponse({ error: "run in progress" }, 409)));
    const missing = clientWith(vi.fn(async () => jsonResponse({ error: "gone" }, 404)));

    await expect(conflict.restore(projectId, versionId)).rejects.toMatchObject({ status: 409 });
    await expect(missing.removeProject(projectId)).rejects.toMatchObject({ status: 404 });
  });

  test("treats a transport failure or an unexpected body as an unavailable manager", async () => {
    const broken = clientWith(vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    }));
    const garbage = clientWith(vi.fn(async () => jsonResponse({ nope: true })));

    const transportError = await broken.ensure(projectId, "ma-k3x9q2ab").catch((error: unknown) => error);
    expect(transportError).toBeInstanceOf(ManagerError);
    expect((transportError as ManagerError).status).toBeNull();

    await expect(garbage.ensure(projectId, "ma-k3x9q2ab")).rejects.toMatchObject({ status: 200 });
  });

  test("aborts a hanging call once its timeout elapses", async () => {
    vi.useFakeTimers();
    const hanging: ManagerFetch = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted.")));
      });

    const client = clientWith(hanging);
    const pending = client.kick(projectId, "ma-k3x9q2ab");
    const rejection = expect(pending).rejects.toBeInstanceOf(ManagerError);
    await vi.advanceTimersByTimeAsync(MANAGER_TIMEOUTS.kick);
    await rejection;
  });

  test("keeps the deadline alive while the response body is still being read", async () => {
    vi.useFakeTimers();
    // Headers resolve immediately; the body never arrives. Clearing the timer when
    // the headers land would let this hang forever.
    const stalledBody = (): { fetch: ManagerFetch; aborted: () => boolean } => {
      let aborted = false;
      const fetch: ManagerFetch = (_url, init) =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                init.signal?.addEventListener("abort", () => {
                  aborted = true;
                  controller.error(new Error("The operation was aborted."));
                });
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      return { fetch, aborted: () => aborted };
    };

    const ensure = stalledBody();
    const ensureClient = clientWith(ensure.fetch);
    const ensureCall = ensureClient.ensure(projectId, "ma-k3x9q2ab");
    const ensureRejection = expect(ensureCall).rejects.toBeInstanceOf(ManagerError);
    await vi.advanceTimersByTimeAsync(MANAGER_TIMEOUTS.ensure);
    await ensureRejection;
    expect(ensure.aborted()).toBe(true);

    // The same applies to the health probe, which must report "down", not hang.
    const health = stalledBody();
    const healthClient = clientWith(health.fetch);
    const healthCall = healthClient.health(10);
    await vi.advanceTimersByTimeAsync(50);
    await expect(healthCall).resolves.toBe(false);
    expect(health.aborted()).toBe(true);
  });

  test("probes health without the bearer secret and reports down on failure", async () => {
    const fetchImpl = vi.fn<ManagerFetch>(async () => jsonResponse({ ok: true, version: "0.1.0", containers: 2 }));
    const client = clientWith(fetchImpl);

    await expect(client.health()).resolves.toBe(true);
    expect(fetchImpl.mock.calls[0][0]).toBe(`${baseUrl}/health`);
    expect(fetchImpl.mock.calls[0][1].headers).toBeUndefined();

    const down = clientWith(vi.fn<ManagerFetch>(async () => jsonResponse({ ok: false, version: "0.1.0", containers: 0 })));
    await expect(down.health()).resolves.toBe(false);
    const unreachable = clientWith(vi.fn<ManagerFetch>(async () => {
      throw new Error("timeout");
    }));
    await expect(unreachable.health()).resolves.toBe(false);
  });

  test("builds the SSE stream URL from the configured base URL", () => {
    const client = clientWith(vi.fn());
    expect(client.streamUrl(projectId, "a.b")).toBe(
      `${baseUrl}/projects/${projectId}/stream?token=a.b`,
    );
    expect(new ManagerClient({ baseUrl: `${baseUrl}/`, secret, fetch: vi.fn() }).streamUrl(projectId, "t")).toBe(
      `${baseUrl}/projects/${projectId}/stream?token=t`,
    );
  });

  test("caches the environment-configured client and refuses to guess one", () => {
    expect(() => getManagerClient()).toThrow(ManagerError);

    process.env.MANAGER_URL = baseUrl;
    process.env.MA_SHARED_SECRET = secret;
    expect(getManagerClient()).toBe(getManagerClient());
    expect(getManagerClient().baseUrl).toBe(baseUrl);

    resetManagerClientForTests();
    expect(getManagerClient()).not.toBeUndefined();
  });

  test("uses the timeouts documented in the architecture", () => {
    expect(MANAGER_TIMEOUTS).toMatchObject({
      health: 3_000,
      kick: 5_000,
      ensure: 60_000,
    });
  });
});
