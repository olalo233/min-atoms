import type { RunEvent } from "@min-atoms/protocol";
import type { ManagerStore, StoredEvent } from "./store";
import { serialLane } from "./serial";

type Listener = (record: StoredEvent) => void;

export class DurableEvents {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly write = serialLane();

  constructor(private readonly store: ManagerStore) {}

  subscribe(projectId: string, listener: Listener): () => void {
    const listeners = this.listeners.get(projectId) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(projectId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(projectId);
    };
  }

  private publish(projectId: string, records: StoredEvent[]): void {
    for (const record of records) {
      for (const listener of this.listeners.get(projectId) ?? []) {
        // A broken subscriber cannot turn a committed append into a failed
        // write or prevent healthy subscribers from receiving the event.
        try { listener(record); } catch { this.listeners.get(projectId)?.delete(listener); }
      }
    }
  }

  // T12 calls append with its mapped events (batching belongs to T12). A single
  // lane keeps database IDs, commit order and live publication order aligned.
  append(projectId: string, events: RunEvent[]): Promise<StoredEvent[]> {
    return this.write(async () => {
      const records = await this.store.appendEvents(projectId, events);
      this.publish(projectId, records);
      return records;
    });
  }

  recover(now: Date): Promise<void> {
    return this.write(async () => {
      const recovered = await this.store.recover(now);
      for (const { projectId, records } of recovered) this.publish(projectId, records);
    });
  }

  listenerCount(projectId: string): number {
    return this.listeners.get(projectId)?.size ?? 0;
  }
}

export interface HeartbeatTimers {
  every(callback: () => void, ms: number): () => void;
}
export const heartbeatTimers: HeartbeatTimers = {
  every(callback, ms) {
    const timer = setInterval(callback, ms);
    return () => clearInterval(timer);
  },
};

export function eventStream(options: {
  projectId: string; after: number; events: DurableEvents; store: ManagerStore;
  signal: AbortSignal; timers?: HeartbeatTimers;
}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let cleanup = () => {};
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let cursor = options.after;
      let backfilling = true;
      let closed = false;
      const buffered = new Map<number, StoredEvent>();
      let unsubscribe = () => {};
      let stopTimer = () => {};
      cleanup = () => {
        if (closed) return;
        closed = true;
        unsubscribe(); stopTimer(); buffered.clear();
        options.signal.removeEventListener("abort", abort);
      };
      const abort = () => { cleanup(); controller.close(); };
      const fail = () => {
        if (closed) return;
        cleanup(); controller.error(new Error("Event stream unavailable"));
      };
      const send = (record: StoredEvent) => {
        if (closed || record.id <= cursor) return;
        controller.enqueue(encoder.encode(`event: run-event\nid: ${record.id}\ndata: ${JSON.stringify(record)}\n\n`));
        cursor = record.id;
      };
      // Attach BEFORE any asynchronous backlog query.
      unsubscribe = options.events.subscribe(options.projectId, record => {
        try {
          if (backfilling) buffered.set(record.id, record);
          else send(record);
        } catch { fail(); }
      });
      options.signal.addEventListener("abort", abort, { once: true });
      if (options.signal.aborted) { abort(); return; }
      stopTimer = (options.timers ?? heartbeatTimers).every(() => {
        try { if (!closed) controller.enqueue(encoder.encode(": hb\n\n")); } catch { fail(); }
      }, 15_000);
      void options.store.backlog(options.projectId, cursor).then(records => {
        if (closed) return;
        for (const record of records.sort((a, b) => a.id - b.id)) send(record);
        for (const record of [...buffered.values()].sort((a, b) => a.id - b.id)) send(record);
        buffered.clear(); backfilling = false;
      }).catch(fail);
    },
    cancel() { cleanup(); },
  });
}
