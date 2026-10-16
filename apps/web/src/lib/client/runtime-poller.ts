import type { VmStatus } from "../runtime";
import type { WorkbenchSource } from "./source";
import type { WorkbenchStore } from "./store";

/** One workbench poll loop, with a separate 30 s automatic wake budget. */
export function startRuntimePolling(source: WorkbenchSource, store: WorkbenchStore) {
  let stopped = false;
  let polling = false;
  let ensuring = false;
  let lastWakeAt = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const ensurePreview = async () => {
    if (ensuring || store.getSnapshot().previewReady) return;
    ensuring = true;
    try {
      await source.ensure();
      const url = await source.getPreviewUrl();
      if (!stopped && store.getSnapshot().vmUp) store.setPreviewReady(url);
    } catch {
      // The next healthy poll retries container readiness.
    } finally {
      ensuring = false;
    }
  };

  const poll = async (retry = false) => {
    if (stopped || polling) return;
    polling = true;
    if (timer) clearTimeout(timer);
    try {
      let status: VmStatus;
      try {
        status = await source.getVmStatus();
      } catch {
        status = { up: false, phase: "unavailable", detail: "暂时无法连接运行环境，请稍后重试。" };
      }
      if (stopped) return;
      store.setVmStatus(status);
      if (status.up) {
        void ensurePreview();
      } else if (retry || ((status.phase === "stopped" || status.phase === "retired") && Date.now() - lastWakeAt >= 30_000)) {
        lastWakeAt = Date.now();
        store.setRuntimeWakePending(true);
        try {
          const result = await source.wakeRuntime();
          if (!stopped) store.setVmStatus({ up: false, ...result });
        } catch {
          if (!stopped) store.setVmStatus({ up: false, phase: "error", detail: "启动请求未完成，请重试。" });
        } finally {
          if (!stopped) store.setRuntimeWakePending(false);
        }
      }
    } finally {
      polling = false;
      if (!stopped) timer = setTimeout(() => void poll(), 10_000);
    }
  };

  void poll();
  return {
    retry: () => poll(true),
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
