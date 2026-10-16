import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { getCurrentUser } = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser }));

import { GET } from "@/app/api/vm/route";
import { POST } from "@/app/api/vm/wake/route";
import { RUNTIME_PHASES } from "@/lib/runtime";
import { resetControllerCacheForTests } from "@/lib/server/controller";
import { resetManagerClientForTests } from "@/lib/server/manager";
import { resetVmCacheForTests } from "@/lib/server/vm";

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  vi.stubEnv("MANAGER_URL", "https://manager.test");
  vi.stubEnv("MA_SHARED_SECRET", "test-manager-secret");
  vi.stubEnv("CONTROLLER_URL", "https://controller.test/");
  vi.stubEnv("CONTROLLER_TOKEN", "test-controller-token");
  vi.stubGlobal("fetch", fetchMock);
  getCurrentUser.mockResolvedValue({ id: "user" });
  fetchMock.mockReset();
  resetControllerCacheForTests();
  resetManagerClientForTests();
  resetVmCacheForTests();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const json = (body: unknown) => Response.json(body);

describe("authenticated runtime routes", () => {
  test("requires a session before probing health or requesting wake", async () => {
    getCurrentUser.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect((await POST()).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("healthy manager wins over controller and status is cached for 10 s", async () => {
    fetchMock.mockImplementation(async () => json({ ok: true, version: "test", containers: 0 }));
    expect(await (await GET()).json()).toEqual({ up: true, phase: "running" });
    await GET();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://manager.test/health");
    await vi.advanceTimersByTimeAsync(10_000);
    await GET();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test.each(RUNTIME_PHASES)("manager down exposes controller phase %s", async (phase) => {
    const controller = { phase, detail: "中文状态说明" };
    fetchMock.mockResolvedValueOnce(json({ ok: false, version: "test", containers: 0 })).mockResolvedValueOnce(json(controller));
    const response = await GET();
    expect(await response.json()).toEqual({ up: false, ...controller });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fetchMock.mock.calls[1]).toEqual(["https://controller.test/status", expect.objectContaining({
      method: "GET", headers: { authorization: "Bearer test-controller-token" }, signal: expect.any(AbortSignal), cache: "no-store",
    })]);
    await GET();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test.each(["CONTROLLER_URL", "CONTROLLER_TOKEN"])("unconfigured %s falls back without a controller call", async (key) => {
    vi.stubEnv(key, "");
    fetchMock.mockResolvedValue(json({ ok: false, version: "test", containers: 0 }));
    expect(await (await GET()).json()).toEqual({ up: false, phase: "unavailable", detail: "自动启动暂不可用，请稍后重试。" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test.each(["network", "http", "invalid"])("controller %s failure is unavailable and does not expose internals", async (failure) => {
    fetchMock.mockResolvedValueOnce(json({ ok: false, version: "test", containers: 0 }));
    if (failure === "network") fetchMock.mockRejectedValueOnce(new Error("private host/token"));
    else fetchMock.mockResolvedValueOnce(failure === "http" ? new Response("private", { status: 503 }) : json({ phase: "private" }));
    const result = await (await GET()).json();
    expect(result).toEqual({ up: false, phase: "unavailable", detail: "暂时无法连接启动服务，请稍后重试。" });
  });

  test("controller body reads remain inside the 5 s deadline", async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: false, version: "test", containers: 0 }));
    fetchMock.mockImplementationOnce(async (_url, init) => ({
      ok: true,
      json: () => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    } as Response));
    const pending = GET();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await (await pending).json()).toMatchObject({ up: false, phase: "unavailable" });
  });

  test("wake forwards once, dedupes concurrent/repeated requests for 15 s, then allows another", async () => {
    fetchMock.mockResolvedValue(json({ phase: "starting" }));
    const responses = await Promise.all([POST(), POST()]);
    for (const response of responses) expect(await response.json()).toEqual({ phase: "starting" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]).toEqual(["https://controller.test/wake", expect.objectContaining({
      method: "POST", headers: { authorization: "Bearer test-controller-token" }, signal: expect.any(AbortSignal),
    })]);
    await vi.advanceTimersByTimeAsync(14_999);
    await POST();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await POST();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("wake invalidates a previously cached stopped status", async () => {
    fetchMock.mockImplementation(async (url) => json(String(url).endsWith("/health") ? { ok: false } : { phase: String(url).endsWith("/wake") ? "starting" : "stopped" }));
    await GET();
    await POST();
    await GET();
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});

test.each(["restoring", "stopping", "retiring", "error", "unavailable"] as const)("wake preserves controller %s and its user-safe detail", async (phase) => {
  fetchMock.mockResolvedValue(json({ phase, detail: "请稍后重试" }));
  expect(await (await POST()).json()).toEqual({ phase, detail: "请稍后重试" });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("unreachable wake returns unavailable without leaking transport errors", async () => {
  fetchMock.mockRejectedValue(new Error("private controller configuration"));
  expect(await (await POST()).json()).toEqual({ phase: "unavailable", detail: "暂时无法连接启动服务，请稍后重试。" });
});
