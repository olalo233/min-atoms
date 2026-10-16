import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { RuntimePhase, VmStatus } from "@/lib/runtime";
import { startRuntimePolling } from "@/lib/client/runtime-poller";
import type { WorkbenchSource } from "@/lib/client/source";
import { WorkbenchStore } from "@/lib/client/store";

let poller: ReturnType<typeof startRuntimePolling> | undefined;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10_000); });
afterEach(() => { poller?.stop(); vi.useRealTimers(); });

function setup(phase: RuntimePhase, up = false) {
  const store = new WorkbenchStore("project");
  const source = {
    getVmStatus: vi.fn().mockResolvedValue({ up, phase }),
    wakeRuntime: vi.fn().mockResolvedValue({ phase: phase === "retired" ? "restoring" : "starting" }),
    ensure: vi.fn().mockResolvedValue({}),
    getPreviewUrl: vi.fn().mockResolvedValue("https://preview.test"),
  };
  poller = startRuntimePolling(source as unknown as WorkbenchSource, store);
  return { store, source };
}

const tick = () => vi.advanceTimersByTimeAsync(0);

describe("workbench runtime polling", () => {
  test.each(["stopped", "retired"] as const)("automatically wakes %s and throttles to one call per 30 s", async (phase) => {
    const { source, store } = setup(phase);
    await tick();
    expect(source.wakeRuntime).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().runtimePhase).toBe(phase === "retired" ? "restoring" : "starting");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(source.wakeRuntime).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(source.wakeRuntime).toHaveBeenCalledTimes(2);
    expect(source.ensure).not.toHaveBeenCalled();
  });

  test.each(["running", "starting", "restoring", "stopping", "retiring", "error", "unavailable"] as const)("does not automatically wake %s", async (phase) => {
    const { source } = setup(phase);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(source.wakeRuntime).not.toHaveBeenCalled();
  });

  test("wakes after retiring becomes retired", async () => {
    const { source } = setup("retiring");
    await tick();
    source.getVmStatus.mockResolvedValue({ up: false, phase: "retired" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(source.wakeRuntime).toHaveBeenCalledTimes(1);
  });

  test.each(["error", "unavailable"] as const)("explicit retry wakes %s and shares the in-flight guard", async (phase) => {
    const { source, store } = setup(phase);
    await tick();
    let finish!: (value: { phase: "starting" }) => void;
    source.wakeRuntime.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const retry = poller!.retry();
    await tick();
    expect(store.getSnapshot().runtimeWakePending).toBe(true);
    await poller!.retry();
    expect(source.wakeRuntime).toHaveBeenCalledTimes(1);
    finish({ phase: "starting" });
    await retry;
    expect(store.getSnapshot()).toMatchObject({ runtimePhase: "starting", runtimeWakePending: false });
  });

  test("health recovery ensures preview and existing queued-run kick path; failed ensure is retried", async () => {
    const { source, store } = setup("starting");
    await tick();
    source.getVmStatus.mockResolvedValue({ up: true, phase: "running" });
    source.ensure.mockRejectedValueOnce(new Error("not ready"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.getSnapshot().previewReady).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.getSnapshot()).toMatchObject({ previewReady: true, previewUrl: "https://preview.test", runtimeWaitingSince: null });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(source.ensure).toHaveBeenCalledTimes(2);
    source.getVmStatus.mockResolvedValue({ up: false, phase: "stopped" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.getSnapshot().previewReady).toBe(false);
    expect(store.getSnapshot().runtimeWaitingSince).not.toBeNull();
    source.getVmStatus.mockResolvedValue({ up: true, phase: "running" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(source.ensure).toHaveBeenCalledTimes(3);
  });

  test("failed probes show unavailable; wake failures clear busy and allow retry", async () => {
    const { source, store } = setup("starting");
    await tick();
    source.getVmStatus.mockRejectedValue(new Error("offline"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.getSnapshot().runtimePhase).toBe("unavailable");
    source.wakeRuntime.mockRejectedValue(new Error("offline"));
    await poller!.retry();
    expect(store.getSnapshot()).toMatchObject({ runtimePhase: "error", runtimeWakePending: false });
  });

  test("cleanup ignores late status results and stops polling", async () => {
    const { source, store } = setup("starting");
    await tick();
    let finish!: (value: VmStatus) => void;
    source.getVmStatus.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await vi.advanceTimersByTimeAsync(10_000);
    poller!.stop();
    finish({ up: true, phase: "running" });
    await tick();
    expect(store.getSnapshot().vmUp).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(source.getVmStatus).toHaveBeenCalledTimes(2);
  });
});
