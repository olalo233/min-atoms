import { afterAll, beforeAll, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@min-atoms/db/schema";
import { appendMessage } from "@min-atoms/db";
import { ManagerStreamEventSchema, RunEventSchema, signSseToken, type RunEvent } from "@min-atoms/protocol";
import { createManagerStore } from "../src/store";
import { DurableEvents } from "../src/events";
import { createManager } from "../src/manager";
import { ProjectRuntime } from "../src/runtime";
import { ControlledTimers, DockerProcess, at, id, label, origin, secret, textEvent } from "./helpers";

const client = new PGlite();
const queries: string[] = [];
const db = drizzle(client, { schema, logger: { logQuery(query) { queries.push(query); } } });
const store = createManagerStore(db);
let ownerId: string;
let number = 0;

beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url)) });
  const [owner] = await db.insert(schema.users).values({ username: "manager-tests", passwordHash: "test-only" }).returning();
  ownerId = owner.id;
}, 30_000);
afterAll(async () => { await client.close(); });

async function project(projectId?: string) {
  const previewLabel = label(++number);
  await db.insert(schema.previewHosts).values({ label: previewLabel });
  const [project] = await db.insert(schema.projects).values({ id: projectId, ownerId, previewLabel, name: "Manager test" }).returning();
  return project;
}
async function run(projectId: string, status: "queued" | "running" | "succeeded", mode: "build" | "chat" = "build") {
  return db.transaction(async tx => {
    const message = await appendMessage(tx, projectId, { role: "user", mode, content: "test input", runId: null, versionId: null });
    const [run] = await tx.insert(schema.runs).values({ projectId, userMessageId: message.id, mode, status,
      startedAt: status === "running" ? new Date(at) : null }).returning();
    return run;
  });
}

// Tests share an isolated in-memory SQL database and the accepted migrations;
// none of them create a postgres.js connection or inspect process credentials.
test("SQL event store persists full accepted payloads and queries project cursor across runs", async () => {
  const p = await project(); const other = await project();
  const first = await run(p.id, "succeeded"); const second = await run(p.id, "succeeded");
  const foreign = await run(other.id, "succeeded");
  const events = new DurableEvents(store);
  const input: RunEvent[] = [
    { runId: first.id, seq: 1, at, kind: "status", status: "verifying", detail: "checking" },
    { runId: first.id, seq: 2, at, kind: "thinking", delta: "thought\n" },
    { runId: first.id, seq: 3, at, kind: "tool", phase: "end", toolCallId: "call", name: "bash", title: "检查", ok: false, summary: "result" },
    { runId: first.id, seq: 4, at, kind: "version", versionId: id(99), number: 1, commitSha: "a".repeat(40), summary: "done" },
    { runId: first.id, seq: 5, at, kind: "error", message: "failure" },
    { ...textEvent(6, first.id) },
  ];
  const published: RunEvent[] = [];
  const committedReads: Promise<unknown>[] = [];
  events.subscribe(p.id, record => {
    published.push(record.event);
    committedReads.push(db.select().from(schema.runEvents).where(eq(schema.runEvents.id, record.id)).then(rows => {
      expect(rows).toHaveLength(1);
      expect(rows[0].payload).toEqual(record.event);
    }));
  });
  const saved = await events.append(p.id, input);
  await Promise.all(committedReads);
  expect(published).toEqual(input);
  const foreignRecords = await events.append(other.id, [textEvent(1, foreign.id)]);
  const next = await events.append(p.id, [textEvent(1, second.id)]);
  const backlog = await store.backlog(p.id, saved[2].id);
  expect(backlog.map(row => row.event)).toEqual([...input.slice(3), textEvent(1, second.id)]);
  expect(backlog.some(row => row.id === foreignRecords[0].id)).toBe(false);
  expect(next[0].id).toBeGreaterThan(foreignRecords[0].id);
  for (const row of await db.select().from(schema.runEvents).where(eq(schema.runEvents.projectId, p.id))) {
    const payload = RunEventSchema.parse(row.payload);
    expect(row.seq).toBe(payload.seq); expect(row.kind).toBe(payload.kind); expect(row.runId).toBe(payload.runId);
  }
});

test("SQL append rejects another project's run, duplicate/gapped sequence and rolls back a whole batch", async () => {
  const p = await project(); const other = await project();
  const first = await run(p.id, "running"); const foreign = await run(other.id, "running");
  const events = new DurableEvents(store);
  const seen: unknown[] = [];
  events.subscribe(p.id, record => seen.push(record));
  await expect(events.append(p.id, [textEvent(1, foreign.id)])).rejects.toThrow("does not belong");
  await expect(events.append(p.id, [textEvent(1, first.id), textEvent(3, first.id)])).rejects.toThrow("sequence");
  expect(await store.backlog(p.id, 0)).toEqual([]);
  expect(seen).toEqual([]);
  await events.append(p.id, [textEvent(1, first.id)]);
  await expect(events.append(p.id, [textEvent(1, first.id)])).rejects.toThrow("sequence");
  await expect(events.append(p.id, [{ ...textEvent(2, first.id), seq: 0 }])).rejects.toThrow();
  await events.append(p.id, [textEvent(2, first.id)]);
  expect((await store.backlog(p.id, 0)).map(row => row.event.seq)).toEqual([1, 2]);
  // Finish these fixtures so later recovery cases do not touch them.
  await db.update(schema.runs).set({ status: "succeeded" }).where(eq(schema.runs.projectId, p.id));
  await db.update(schema.runs).set({ status: "succeeded" }).where(eq(schema.runs.projectId, other.id));
});

test("startup recovery atomically fails interrupted runs, appends sequenced terminal events/messages, kicks distinct queued projects", async () => {
  const p = await project(); const other = await project(); const terminalProject = await project();
  const first = await run(p.id, "running"); const second = await run(p.id, "running", "chat");
  const queued = await run(p.id, "queued"); await run(p.id, "queued");
  const otherQueued = await run(other.id, "queued", "chat");
  const terminal = await run(terminalProject.id, "succeeded");
  await store.appendEvents(p.id, [textEvent(1, first.id), textEvent(2, first.id)]);
  const docker = new DockerProcess();
  const runtime = new ProjectRuntime(store, { spawn: docker.spawn });
  const now = Date.parse(at) + 30_000;
  const manager = createManager({ store, runtime, secret, webOrigin: origin, now: () => now });
  const observed: RunEvent[] = [];
  const committedReads: Promise<unknown>[] = [];
  manager.events.subscribe(p.id, record => {
    observed.push(record.event);
    committedReads.push(db.select().from(schema.runs).where(eq(schema.runs.id, record.event.runId)).then(rows => {
      expect(rows[0].status).toBe("failed");
      expect(rows[0].error).toBe("环境重启");
    }));
  });
  const kicked: string[] = [];
  queries.length = 0;
  const result = await manager.initialize(async projectId => {
    expect((await db.select().from(schema.runs).where(eq(schema.runs.id, first.id)))[0].status).toBe("failed");
    kicked.push(projectId);
  });
  await Promise.all(committedReads);
  expect(result.queuedProjects).toEqual([p.id, other.id].sort());
  expect(kicked).toEqual([p.id, other.id].sort());
  for (const interrupted of [first, second]) {
    const [row] = await db.select().from(schema.runs).where(eq(schema.runs.id, interrupted.id));
    expect(row).toMatchObject({ status: "failed", error: "环境重启", finishedAt: new Date(now) });
    expect(row.startedAt).toEqual(interrupted.startedAt);
    const events = (await store.backlog(p.id, 0)).filter(record => record.event.runId === interrupted.id);
    const offset = interrupted.id === first.id ? 2 : 0;
    expect(events.slice(-2).map(record => record.event)).toEqual([
      { runId: interrupted.id, seq: offset + 1, at: new Date(now).toISOString(), kind: "error", message: "环境重启" },
      { runId: interrupted.id, seq: offset + 2, at: new Date(now).toISOString(), kind: "status", status: "failed", detail: "环境重启" },
    ]);
  }
  const messages = await db.select().from(schema.messages).where(eq(schema.messages.projectId, p.id)).orderBy(schema.messages.seq);
  expect(messages.map(message => message.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(messages.slice(-2).every(message => message.role === "assistant" && message.content === "环境重启" && message.versionId === null)).toBe(true);
  expect(messages.slice(-2).map(message => message.mode).sort()).toEqual(["build", "chat"]);
  expect(observed).toHaveLength(4);
  expect(queries.some(query => query.includes('from "projects"') && query.includes("for update"))).toBe(true);
  expect(queries.some(query => query.includes('from "runs"') && query.includes("for update"))).toBe(true);
  for (const pending of [queued, otherQueued]) expect((await db.select().from(schema.runs).where(eq(schema.runs.id, pending.id)))[0].status).toBe("queued");
  expect((await db.select().from(schema.runs).where(eq(schema.runs.id, terminal.id)))[0].status).toBe("succeeded");
  // No callback means pending work stays pending; recovery is idempotent.
  const withoutDriver = await manager.initialize();
  expect(withoutDriver.queuedProjects).toEqual(result.queuedProjects);
  expect(observed).toHaveLength(4);
  expect(await db.select().from(schema.messages).where(eq(schema.messages.projectId, p.id))).toHaveLength(6);
  expect((await db.select().from(schema.runs).where(eq(schema.runs.id, queued.id)))[0].status).toBe("queued");
  // Clear queued fixtures without making any claim that generation executed.
  await db.update(schema.runs).set({ status: "cancelled" }).where(eq(schema.runs.status, "queued"));
});

test("SQL recovery rolls back state, events and publication if appendMessage fails", async () => {
  const p = await project(); const interrupted = await run(p.id, "running");
  await store.appendEvents(p.id, [textEvent(1, interrupted.id)]);
  const events = new DurableEvents(store);
  const seen: unknown[] = [];
  events.subscribe(p.id, record => seen.push(record));
  // Fail the actual SQL insertion made by appendMessage, after terminal event
  // inserts and state update, proving all writes share the caller transaction.
  await db.execute(sql`create function reject_recovery_message() returns trigger language plpgsql as $$
    begin if NEW.role = 'assistant' then raise exception 'test message failure'; end if; return NEW; end; $$`);
  await db.execute(sql`create trigger reject_recovery before insert on messages for each row execute function reject_recovery_message()`);
  try {
    await expect(events.recover(new Date(at))).rejects.toThrow();
    const [row] = await db.select().from(schema.runs).where(eq(schema.runs.id, interrupted.id));
    expect(row).toMatchObject({ status: "running", error: null, finishedAt: null });
    expect((await store.backlog(p.id, 0)).map(record => record.event)).toEqual([textEvent(1, interrupted.id)]);
    expect(await db.select().from(schema.messages).where(and(eq(schema.messages.projectId, p.id), eq(schema.messages.role, "assistant")))).toEqual([]);
    expect(seen).toEqual([]);
  } finally {
    await db.execute(sql`drop trigger reject_recovery on messages`);
    await db.execute(sql`drop function reject_recovery_message()`);
  }
  await events.recover(new Date(at));
  expect((await store.backlog(p.id, 0)).map(record => record.event.seq)).toEqual([1, 2, 3]);
  expect(seen).toHaveLength(2);
});

test("SQL LRU activity excludes queued work while DELETE activity protects queued and running work", async () => {
  const p = await project();
  const other = await project();
  const foreign = await run(other.id, "running");
  expect(await store.busy(p.id)).toBe(false);
  expect(await store.running(p.id)).toBe(false);
  const pending = await run(p.id, "queued");
  expect(await store.busy(p.id)).toBe(true);
  expect(await store.running(p.id)).toBe(false);
  await db.update(schema.runs).set({ status: "running" }).where(eq(schema.runs.id, pending.id));
  expect(await store.busy(p.id)).toBe(true);
  expect(await store.running(p.id)).toBe(true);
  await db.update(schema.runs).set({ status: "succeeded" }).where(eq(schema.runs.id, pending.id));
  expect(await store.busy(p.id)).toBe(false);
  expect(await store.running(p.id)).toBe(false);
  await db.update(schema.runs).set({ status: "succeeded" }).where(eq(schema.runs.id, foreign.id));
});

test("uppercase SSE path/token uses the canonical SQL project ID for backlog and durable live delivery", async () => {
  const p = await project("abcdefab-cdef-4abc-8def-abcdefabcdef");
  const completed = await run(p.id, "succeeded");
  const docker = new DockerProcess();
  const runtime = new ProjectRuntime(store, { spawn: docker.spawn });
  const timers = new ControlledTimers();
  const now = Date.parse(at);
  const manager = createManager({ store, runtime, secret, webOrigin: origin, timers, now: () => now });
  const requestedId = p.id.toUpperCase();
  expect((await store.project(requestedId))?.id).toBe(p.id);
  const token = await signSseToken(requestedId, secret, now);
  const lowerToken = await signSseToken(p.id, secret, now);
  expect((await manager.app.request(`/projects/${requestedId}/stream?token=${lowerToken}`)).status).toBe(401);
  const [backlog] = await manager.events.append(p.id, [textEvent(1, completed.id)]);
  const response = await manager.app.request(`/projects/${requestedId}/stream?token=${token}`);
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const readRecord = async () => {
    const frame = new TextDecoder().decode((await reader.read()).value);
    return ManagerStreamEventSchema.parse(JSON.parse(frame.split("\ndata: ")[1].trim()));
  };
  try {
    expect(manager.events.listenerCount(p.id)).toBe(1);
    expect(manager.events.listenerCount(requestedId)).toBe(0);
    expect(await readRecord()).toEqual(backlog);
    const [live] = await manager.events.append(p.id, [textEvent(2, completed.id)]);
    expect(await readRecord()).toEqual(live);
    expect((await store.backlog(p.id, backlog.id))).toEqual([live]);
  } finally { await reader.cancel(); }
  expect(manager.events.listenerCount(p.id)).toBe(0);
  expect(timers.callbacks.size).toBe(0);
});
