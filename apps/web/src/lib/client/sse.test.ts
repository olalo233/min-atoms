import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { RunEvent } from "@min-atoms/protocol";

import { subscribeRunEvents, type StreamCredentials } from "./sse";

const RUN_ID = "22222222-2222-4222-8222-222222222222";
const STREAM_BASE = "https://ma-vm.expii.top/projects/11111111-1111-4111-8111-111111111111/stream";

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, ((event: { data: string }) => void)[]>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  close(): void {
    this.closed = true;
  }

  emit(payload: { id: number; event: RunEvent }): void {
    for (const listener of this.listeners.get("run-event") ?? []) {
      listener({ data: JSON.stringify(payload) });
    }
  }
}

const textEvent = (seq: number): RunEvent => ({
  runId: RUN_ID,
  seq,
  at: "2026-10-08T12:00:00.000Z",
  kind: "text",
  delta: "x",
});

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

describe("subscribeRunEvents", () => {
  let original: unknown;

  beforeEach(() => {
    original = globalThis.EventSource;
    FakeEventSource.instances = [];
    (globalThis as Record<string, unknown>).EventSource = FakeEventSource;
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).EventSource = original;
  });

  function credentialQueue(credentials: StreamCredentials[]) {
    let index = 0;
    return async () => credentials[Math.min(index++, credentials.length - 1)];
  }

  it("builds the initial URL from streamUrl with token and after params, no duplicate query", async () => {
    const after = 42;
    const unsubscribe = subscribeRunEvents({
      fetchCredentials: credentialQueue([{ token: "t1", streamUrl: `${STREAM_BASE}?token=t1` }]),
      getAfter: () => after,
      onEvent: () => {},
      reconnectDelayMs: () => 5,
      renewAfterMs: 60_000,
    });
    await tick(10);

    expect(FakeEventSource.instances).toHaveLength(1);
    const url = new URL(FakeEventSource.instances[0].url);
    expect(url.origin + url.pathname).toBe(STREAM_BASE);
    expect(url.searchParams.getAll("token")).toEqual(["t1"]);
    expect(url.searchParams.get("after")).toBe("42");
    expect(url.searchParams.size).toBe(2);
    unsubscribe();
  });

  it("reconnects with a fresh token and the latest after cursor", async () => {
    let after = 0;
    const fetchCredentials = credentialQueue([
      { token: "t1", streamUrl: `${STREAM_BASE}?token=t1` },
      // The server embeds the issued token; a stale one must be replaced.
      { token: "t2", streamUrl: `${STREAM_BASE}?token=stale` },
    ]);
    const received: number[] = [];
    const unsubscribe = subscribeRunEvents({
      fetchCredentials,
      getAfter: () => after,
      onEvent: (id) => {
        after = Math.max(after, id);
        received.push(id);
      },
      reconnectDelayMs: () => 5,
      renewAfterMs: 60_000,
    });
    await tick(10);

    const first = FakeEventSource.instances[0];
    first.emit({ id: 7, event: textEvent(1) });
    expect(received).toEqual([7]);

    first.onerror?.();
    await tick(30);

    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
    const url = new URL(FakeEventSource.instances[1].url);
    expect(url.searchParams.getAll("token")).toEqual(["t2"]);
    expect(url.searchParams.get("after")).toBe("7");
    unsubscribe();
  });

  it("renews the connection on schedule with a fresh credential fetch", async () => {
    const fetchCredentials = credentialQueue([
      { token: "t1", streamUrl: `${STREAM_BASE}?token=t1` },
      { token: "t2", streamUrl: `${STREAM_BASE}?token=t2` },
    ]);
    const unsubscribe = subscribeRunEvents({
      fetchCredentials,
      getAfter: () => 0,
      onEvent: () => {},
      reconnectDelayMs: () => 5,
      renewAfterMs: 10,
    });
    await tick(15);
    unsubscribe();

    // Each renewal reconnects with a fresh credential fetch; how many fired
    // inside the window is timing-dependent, so assert on the latest one.
    expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(2);
    const last = FakeEventSource.instances.at(-1);
    expect(last?.closed).toBe(true);
    const url = new URL(last?.url ?? "");
    expect(url.searchParams.getAll("token")).toEqual(["t2"]);
  });

  it("closes the source and stops reconnecting after unsubscribe", async () => {
    let fetches = 0;
    const unsubscribe = subscribeRunEvents({
      fetchCredentials: async () => {
        fetches += 1;
        return { token: "t1", streamUrl: `${STREAM_BASE}?token=t1` };
      },
      getAfter: () => 0,
      onEvent: () => {},
      reconnectDelayMs: () => 5,
      renewAfterMs: 60_000,
    });
    await tick(10);
    unsubscribe();

    const first = FakeEventSource.instances[0];
    expect(first.closed).toBe(true);
    first.onerror?.();
    await tick(40);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(fetches).toBe(1);
  });
});
