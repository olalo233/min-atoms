import { createManagerApp } from "./app";
import { DurableEvents, type HeartbeatTimers } from "./events";
import { ProjectRuntime } from "./runtime";
import type { ManagerStore } from "./store";

export type KickQueuedProject = (projectId: string) => Promise<void>;

export function createManager(options: {
  secret: string; webOrigin: string; store: ManagerStore;
  runtime?: ProjectRuntime; now?: () => number; timers?: HeartbeatTimers;
}) {
  const runtime = options.runtime ?? new ProjectRuntime(options.store);
  const events = new DurableEvents(options.store, options.now);
  const app = createManagerApp({ ...options, runtime, events });
  return {
    app, runtime, events, store: options.store,
    // T12 installs its real queue callback here. With no driver, queued rows
    // remain pending and /kick is absent (never a fake successful endpoint).
    async initialize(kick?: KickQueuedProject): Promise<{ queuedProjects: string[] }> {
      await runtime.initialize();
      await events.recover(new Date(options.now?.() ?? Date.now()));
      const queuedProjects = await options.store.queuedProjects();
      if (kick) for (const projectId of queuedProjects) await kick(projectId);
      return { queuedProjects };
    },
  };
}
