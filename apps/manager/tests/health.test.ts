import { expect, test } from "bun:test";
import { ManagerHealthResponseSchema, signSseToken } from "@min-atoms/protocol";
import { auth, harness, id, label, secret } from "./helpers";

async function idle(h: Awaited<ReturnType<typeof harness>>) {
  const response = await h.app.request("/health");
  expect(response.status).toBe(200);
  return ManagerHealthResponseSchema.parse(await response.json()).idleSeconds;
}

test("health is public and counts only running projects with matching DB, labels and mounts", async () => {
  const h = await harness();
  try {
    h.docker.add(h.store.add(1), h.root);
    h.docker.add(h.store.add(2), h.root, false);
    const foreign = h.docker.add({ id: id(3), previewLabel: label(3) }, h.root);
    foreign.labels = {};
    const forged = h.docker.add(h.store.add(4), h.root);
    forged.mounts[0].Source = "/unrelated/workspace";
    const response = await h.app.request("/health");
    expect(response.status).toBe(200);
    expect(ManagerHealthResponseSchema.parse(await response.json())).toEqual({ ok: true, version: "0.1.0", containers: 1, idleSeconds: 0 });
    expect(h.docker.commands.every(argv => !argv.includes("ma-gateway") && !argv.includes("unrelated"))).toBe(true);
    expect(h.docker.commands.some(argv => argv[1] === "stop")).toBe(false);
  } finally { await h.cleanup(); }
});

test("idle time grows from manager start; health polling and rejected requests do not reset it", async () => {
  const h = await harness();
  try {
    expect(await idle(h)).toBe(0);
    h.advance(2_999);
    expect(await idle(h)).toBe(2);
    h.advance(3_001);
    expect(await idle(h)).toBe(6);
    expect((await h.app.request(`/projects/${id(1)}/ensure`, { method: "POST" })).status).toBe(401);
    expect((await h.app.request(`/projects/${id(1)}/stream?token=bad`)).status).toBe(401);
    expect(await idle(h)).toBe(6);
    // Even a malformed authenticated project request is real operator activity.
    expect((await h.app.request(`/projects/${id(1)}/ensure`, { method: "POST", headers: auth })).status).toBe(400);
    expect(await idle(h)).toBe(0);
    h.advance(10_000);
    expect(await idle(h)).toBe(10);
  } finally { await h.cleanup(); }
});

test("running or queued runs keep idle at zero even without a running container", async () => {
  const h = await harness();
  try {
    h.advance(3_600_000);
    h.store.runningProjects.add(id(1));
    expect(await idle(h)).toBe(0);
    h.store.runningProjects.clear();
    h.store.queued.push(id(2));
    expect(await idle(h)).toBe(0);
    h.store.hasActiveRuns = async () => { throw new Error("database unavailable"); };
    expect((await h.app.request("/health")).status).toBe(503);
  } finally { await h.cleanup(); }
});

test("run completion starts a new idle interval even if health never polled during the run", async () => {
  const h = await harness();
  try {
    Object.assign(h.store, { async finish() {
      h.store.runningProjects.clear();
      return h.store.appendEvents(id(1), [{ kind: "status", status: "succeeded", runId: id(101), seq: 1, at: new Date(h.now()).toISOString() }]);
    } });
    h.store.runningProjects.add(id(1));
    h.advance(3_600_000);
    await h.events.finish(id(1), { runId: id(101), expected: "running", status: "succeeded", content: "done", now: new Date(h.now()) });
    expect(await idle(h)).toBe(0);
    h.advance(25_000);
    expect(await idle(h)).toBe(25);
  } finally { await h.cleanup(); }
});

test("every open SSE stream keeps idle at zero; abort and cancellation reset the interval", async () => {
  const h = await harness();
  const abort = new AbortController();
  try {
    h.store.add(1);
    h.advance(10_000);
    const token = await signSseToken(id(1), secret, h.now());
    const path = `http://manager/projects/${id(1)}/stream?token=${token}`;
    const first = await h.app.request(new Request(path, { signal: abort.signal }));
    const second = await h.app.request(path);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    h.advance(3_600_000);
    expect(await idle(h)).toBe(0);
    abort.abort();
    h.advance(10_000);
    expect(await idle(h)).toBe(0);
    await second.body!.cancel();
    expect(await idle(h)).toBe(0);
    h.advance(30_000);
    expect(await idle(h)).toBe(30);
    expect(h.timers.callbacks.size).toBe(0);
  } finally { abort.abort(); await h.cleanup(); }
});

test("failed SSE backlog closes the stream and resumes idle counting", async () => {
  const h = await harness();
  try {
    h.store.add(1);
    h.store.backlog = async () => { throw new Error("backlog unavailable"); };
    const token = await signSseToken(id(1), secret, h.now());
    const response = await h.app.request(`/projects/${id(1)}/stream?token=${token}`);
    await expect(response.body!.getReader().read()).rejects.toThrow("Event stream unavailable");
    h.advance(12_000);
    expect(await idle(h)).toBe(12);
  } finally { await h.cleanup(); }
});

test("health reports an unavailable runtime instead of a fabricated zero", async () => {
  const h = await harness();
  try {
    h.docker.unavailable = true;
    expect((await h.app.request("/health")).status).toBe(503);
  } finally { await h.cleanup(); }
});
