import { expect, test } from "bun:test";
import { signSseToken, ManagerStreamEventSchema } from "@min-atoms/protocol";
import { DurableEvents } from "../src/events";
import { auth, deferred, harness, id, origin, secret, textEvent, MemoryStore } from "./helpers";

const decode = (value?: Uint8Array) => new TextDecoder().decode(value);
const record = (frame: string) => ManagerStreamEventSchema.parse(JSON.parse(frame.split("\ndata: ")[1].trim()));
async function read(reader: { read(): Promise<{ value?: Uint8Array; done: boolean }> }) {
  return decode((await reader.read()).value);
}

async function stream(h: Awaited<ReturnType<typeof harness>>, after = "0", signal?: AbortSignal, requestOrigin = origin) {
  const token = await signSseToken(id(1), secret, h.now());
  return h.app.request(new Request(`http://manager/projects/${id(1)}/stream?token=${encodeURIComponent(token)}&after=${after}`, {
    headers: { Origin: requestOrigin }, signal,
  }));
}

test("durable writes precede publication, failed writes publish nothing and concurrent writes stay ordered", async () => {
  const store = new MemoryStore();
  const events = new DurableEvents(store);
  const gate = deferred<void>();
  const original = store.appendEvents.bind(store);
  const trace: string[] = [];
  store.appendEvents = async (projectId, input) => {
    trace.push(`write:${input[0].seq}`);
    if (input[0].seq === 1) await gate.promise;
    if (input[0].seq === 3) throw new Error("transaction rolled back");
    const result = await original(projectId, input);
    trace.push(`committed:${input[0].seq}`);
    return result;
  };
  const seen: number[] = [];
  events.subscribe(id(1), row => { trace.push(`published:${row.event.seq}`); seen.push(row.id); });
  const first = events.append(id(1), [textEvent(1)]);
  const second = events.append(id(1), [textEvent(2)]);
  await Promise.resolve();
  expect(seen).toEqual([]);
  expect(trace).toEqual(["write:1"]);
  gate.resolve();
  await Promise.all([first, second]);
  expect(trace).toEqual(["write:1", "committed:1", "published:1", "write:2", "committed:2", "published:2"]);
  await expect(events.append(id(1), [textEvent(3)])).rejects.toThrow("rolled back");
  expect(seen).toEqual([1, 2]);
  expect((await events.append(id(1), [textEvent(4)]))[0].id).toBe(3);
  expect(seen).toEqual([1, 2, 3]);
});

test("stream validates exact-project HMAC, expiry and nonnegative safe cursor; CORS never reflects arbitrary origins", async () => {
  const h = await harness();
  try {
    h.store.add(1);
    expect((await h.app.request(`/projects/${id(1)}/stream`)).status).toBe(401);
    expect((await h.app.request(`/projects/${id(1)}/stream?token=bad`)).status).toBe(401);
    const wrong = await signSseToken(id(2), secret, h.now());
    expect((await h.app.request(`/projects/${id(1)}/stream?token=${wrong}`)).status).toBe(401);
    const expired = await signSseToken(id(1), secret, h.now() - 600_000);
    expect((await h.app.request(`/projects/${id(1)}/stream?token=${expired}`)).status).toBe(401);
    for (const after of ["-1", "NaN", "1.2", "1e3", "9007199254740992", ""]) {
      expect((await stream(h, after)).status).toBe(400);
    }
    const token = await signSseToken(id(1), secret, h.now());
    expect((await h.app.request(`/projects/not-uuid/stream?token=${token}`)).status).toBe(400);
    const denied = await h.app.request(`/projects/${id(1)}/stream`, { headers: { Origin: "https://evil.example" } });
    expect(denied.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const allowed = await h.app.request(`/projects/${id(1)}/stream`, { headers: { Origin: origin } });
    expect(allowed.status).toBe(401);
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    for (const requestOrigin of [origin, "https://evil.example"]) {
      const response = await stream(h, "0", undefined, requestOrigin);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("text/event-stream");
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(requestOrigin === origin ? origin : null);
      expect(response.headers.get("Vary")).toBe("Origin");
      await response.body!.cancel();
    }
    expect(h.events.listenerCount(id(1))).toBe(0);
    expect(h.timers.callbacks.size).toBe(0);
    // T11 provides no fake queue success.
    expect((await h.app.request(`/projects/${id(1)}/kick`, { method: "POST", headers: auth })).status).toBe(404);
  } finally { await h.cleanup(); }
});

test("attach-before-backfill closes the race, sorts IDs, deduplicates live overlap and preserves payloads across runs", async () => {
  const h = await harness();
  try {
    h.store.add(1); h.store.add(2);
    await h.events.append(id(1), [textEvent(1), textEvent(2)]);
    await h.events.append(id(2), [textEvent(1, id(202))]); // unrelated global ID 3
    const gate = deferred<void>();
    const entered = deferred<void>();
    const original = h.store.backlog.bind(h.store);
    h.store.backlog = async (projectId, after) => {
      expect(h.events.listenerCount(projectId)).toBe(1);
      entered.resolve();
      await gate.promise;
      return (await original(projectId, after)).reverse();
    };
    const response = await stream(h);
    await entered.promise;
    await h.events.append(id(1), [textEvent(1, id(102))]); // ID 4 in buffer AND backlog
    const reader = response.body!.getReader();
    gate.resolve();
    const frames = [await read(reader), await read(reader), await read(reader)];
    expect(frames.map(frame => record(frame).id)).toEqual([1, 2, 4]);
    expect(frames.map(frame => record(frame).event)).toEqual([textEvent(1), textEvent(2), textEvent(1, id(102))]);
    expect(frames[0]).toBe(`event: run-event\nid: 1\ndata: ${JSON.stringify({ id: 1, event: textEvent(1) })}\n\n`);
    await h.events.append(id(1), [textEvent(2, id(102))]);
    expect(record(await read(reader)).id).toBe(5);
    expect(h.timers.intervals).toEqual([15_000]);
    h.timers.tick();
    expect(await read(reader)).toBe(": hb\n\n");
    await reader.cancel();
    expect(h.events.listenerCount(id(1))).toBe(0);
    expect(h.timers.callbacks.size).toBe(0);
    await h.events.append(id(1), [textEvent(3, id(102))]);
    h.store.backlog = original;
    const reconnect = await stream(h, "4");
    const next = reconnect.body!.getReader();
    expect([record(await read(next)).id, record(await read(next)).id]).toEqual([5, 6]);
    await next.cancel();
  } finally { await h.cleanup(); }
});

test("events committed after backlog snapshot are drained from the live buffer, including an empty backlog/high cursor", async () => {
  const h = await harness();
  try {
    h.store.add(1);
    const gate = deferred<void>();
    const entered = deferred<void>();
    const original = h.store.backlog.bind(h.store);
    h.store.backlog = async (projectId, after) => {
      const snapshot = await original(projectId, after);
      entered.resolve(); await gate.promise; return snapshot;
    };
    const response = await stream(h, "2");
    await entered.promise;
    await h.events.append(id(1), [textEvent(1), textEvent(2), textEvent(3), textEvent(4)]);
    const reader = response.body!.getReader();
    gate.resolve();
    expect([record(await read(reader)).id, record(await read(reader)).id]).toEqual([3, 4]);
    h.timers.tick();
    expect(await read(reader)).toBe(": hb\n\n");
    await reader.cancel();
  } finally { await h.cleanup(); }
});

test("backlog errors and disconnects during backfill remove subscribers and heartbeat timers", async () => {
  const h = await harness();
  try {
    h.store.add(1);
    h.store.backlog = async () => { throw new Error("database unavailable"); };
    const failed = await stream(h);
    const failedReader = failed.body!.getReader();
    await expect(failedReader.read()).rejects.toThrow("Event stream unavailable");
    expect(h.events.listenerCount(id(1))).toBe(0);
    expect(h.timers.callbacks.size).toBe(0);
    const gate = deferred<void>();
    h.store.backlog = async () => { await gate.promise; return [{ id: 1, event: textEvent(1) }]; };
    const abort = new AbortController();
    const response = await stream(h, "0", abort.signal);
    const reader = response.body!.getReader();
    expect(h.events.listenerCount(id(1))).toBe(1);
    abort.abort();
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    gate.resolve();
    await Promise.resolve();
    expect(h.events.listenerCount(id(1))).toBe(0);
    expect(h.timers.callbacks.size).toBe(0);
    await h.events.append(id(1), [textEvent(1)]);
  } finally { await h.cleanup(); }
});

test("backfill has no silent history limit", async () => {
  const h = await harness();
  try {
    h.store.add(1);
    await h.events.append(id(1), Array.from({ length: 1100 }, (_, index) => textEvent(index + 1)));
    const response = await stream(h);
    const reader = response.body!.getReader();
    for (let index = 1; index <= 1100; index++) expect(record(await read(reader)).id).toBe(index);
    await reader.cancel();
  } finally { await h.cleanup(); }
});

test("a failed subscriber cannot interrupt committed publication to healthy subscribers", async () => {
  const store = new MemoryStore();
  const events = new DurableEvents(store);
  events.subscribe(id(1), () => { throw new Error("disconnected subscriber"); });
  const seen: number[] = [];
  events.subscribe(id(1), record => seen.push(record.id));
  expect((await events.append(id(1), [textEvent(1), textEvent(2)])).map(record => record.id)).toEqual([1, 2]);
  expect(seen).toEqual([1, 2]);
  expect(events.listenerCount(id(1))).toBe(1);
});
