import { WebProjectDetailResponseSchema } from "@min-atoms/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/db/client", async () => {
  const { testDb } = await import("./harness");
  return { getDb: () => testDb(), closeDatabase: async () => {} };
});

vi.mock("@/lib/auth/session", async () => {
  const { harness } = await import("./harness");
  return { getCurrentUser: async () => harness().user };
});

vi.mock("@/lib/server/manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/manager")>();
  const { harness } = await import("./harness");
  return { ...actual, getManagerClient: () => harness().manager };
});

import * as schema from "@min-atoms/db/schema";

import { getProjectDetail } from "@/lib/server/projects";

import {
  harness,
  resetHarness,
  seedMessage,
  seedPreviewHosts,
  seedProject,
  seedRun,
  seedRunEvent,
  seedUser,
  seedVersion,
  startDatabase,
  stopDatabase,
  testDb,
  truncateDatabase,
} from "./harness";

beforeAll(async () => {
  await startDatabase();
});

afterAll(async () => {
  await stopDatabase();
});

beforeEach(async () => {
  await truncateDatabase();
  resetHarness(null);
});

/**
 * The project detail and its SSE cursor must come from one consistent snapshot.
 * The manager is the only writer of run_events and assigns ids in commit order;
 * if the cursor were read separately and after the history, an event committed in
 * between would be absent from history yet below the cursor, and the browser's
 * `after=<cursor>` subscription would skip it forever.
 */
describe("GET /api/projects/:id history snapshot", () => {
  test("an event committed while the detail is read never falls behind the cursor", async () => {
    const owner = await seedUser();
    await seedPreviewHosts(["ma-aaaa1111"]);
    const project = await seedProject({ ownerId: owner.id, previewLabel: "ma-aaaa1111" });
    const message = await seedMessage({ projectId: project.id, seq: 1 });
    const run = await seedRun({ projectId: project.id, userMessageId: message.id, status: "running" });
    const firstEvent = await seedRunEvent({
      projectId: project.id,
      runId: run.id,
      seq: 1,
      kind: "text",
      payload: { delta: "first" },
    });

    // Reproduce the insertion window deterministically: the instant the detail
    // read issues the run_events query, a writer commits the next event. With one
    // snapshot the cursor stays with the returned history; with separate reads the
    // cursor jumps ahead and `after=lastEventId` skips the new event forever.
    const client = harness().client!;
    let injected: Promise<schema.RunEventRecord[]> = Promise.resolve([]);
    let armed = true;
    const armIfEventRead = (sql: unknown) => {
      if (armed && String(sql).includes('from "run_events"')) {
        armed = false;
        injected = testDb()
          .insert(schema.runEvents)
          .values({ projectId: project.id, runId: run.id, seq: 2, kind: "text", payload: { delta: "second" } })
          .returning()
          .execute();
      }
    };

    const originalQuery = client.query.bind(client);
    client.query = ((sql: string, params?: unknown[], options?: unknown) => {
      const result = originalQuery(sql as never, params as never, options as never);
      armIfEventRead(sql);
      return result;
    }) as typeof client.query;

    // Inside `db.transaction()` PGlite hands the callback a transaction-scoped
    // client, so its query has to be wrapped as well.
    const originalTransaction = client.transaction.bind(client) as unknown as (
      callback: (tx: unknown) => Promise<unknown>,
    ) => Promise<unknown>;
    client.transaction = ((callback: (tx: unknown) => unknown) =>
      originalTransaction((tx) => {
        const scoped = tx as { query: (sql: string, params?: unknown[], options?: unknown) => Promise<unknown> };
        const originalTxQuery = scoped.query.bind(scoped);
        scoped.query = (sql, params, options) => {
          const result = originalTxQuery(sql, params, options);
          armIfEventRead(sql);
          return result;
        };
        return Promise.resolve(callback(tx));
      })) as unknown as typeof client.transaction;

    let detail;
    let injectedId = -1;
    try {
      detail = await getProjectDetail(project.id, owner.id);
      const rows = await injected;
      injectedId = rows[0]?.id ?? -1;
    } finally {
      client.query = originalQuery as typeof client.query;
      client.transaction = originalTransaction as unknown as typeof client.transaction;
    }

    expect(detail).not.toBeNull();
    expect(WebProjectDetailResponseSchema.safeParse(detail).success).toBe(true);
    expect(injectedId).toBeGreaterThan(firstEvent.id);

    // The event committed in the window is not part of the snapshot...
    const returnedSeqs = (detail!.runs.find((candidate) => candidate.id === run.id)!.events ?? []).map(
      (event) => event.seq,
    );
    expect(returnedSeqs).toEqual([1]);
    // ...so the cursor must not advance past the returned history, or
    // `after=lastEventId` would skip that event forever.
    expect(detail!.lastEventId).toBe(firstEvent.id);
    expect(injectedId).toBeGreaterThan(detail!.lastEventId);
  });

  test("keeps a finished run's hidden stream events below the cursor and a queued run fully replayable", async () => {
    const owner = await seedUser();
    await seedPreviewHosts(["ma-aaaa1111"]);
    const project = await seedProject({ ownerId: owner.id, previewLabel: "ma-aaaa1111" });
    const message = await seedMessage({ projectId: project.id, seq: 1 });

    const finished = await seedRun({ projectId: project.id, userMessageId: message.id, status: "succeeded" });
    const version = await seedVersion({ projectId: project.id, number: 1, runId: finished.id, screenshot: true });
    await seedRunEvent({ projectId: project.id, runId: finished.id, seq: 1, kind: "text", payload: { delta: "streamed" } });
    await seedRunEvent({ projectId: project.id, runId: finished.id, seq: 2, kind: "thinking", payload: { delta: "hidden" } });
    await seedRunEvent({
      projectId: project.id,
      runId: finished.id,
      seq: 3,
      kind: "tool",
      payload: { phase: "end", toolCallId: "tool-1", name: "read_file", title: "读取 src/App.tsx", ok: true },
    });
    const versionEvent = await seedRunEvent({
      projectId: project.id,
      runId: finished.id,
      seq: 4,
      kind: "version",
      payload: { versionId: version.id, number: 1, commitSha: version.commitSha, summary: "Version 1" },
    });

    const queued = await seedRun({ projectId: project.id, userMessageId: message.id, status: "queued" });
    const queuedEvent = await seedRunEvent({
      projectId: project.id,
      runId: queued.id,
      seq: 1,
      kind: "text",
      payload: { delta: "queued" },
    });

    const detail = await getProjectDetail(project.id, owner.id);
    expect(detail).not.toBeNull();

    // The cursor is the project's newest event, not the newest visible one.
    expect(detail!.lastEventId).toBe(queuedEvent.id);
    expect(versionEvent.id).toBeLessThan(detail!.lastEventId);

    // A finished run replays only tool/version/error; its prose lives in messages.
    const finishedEvents = detail!.runs.find((candidate) => candidate.id === finished.id)!.events ?? [];
    expect(finishedEvents.map((event) => event.kind)).toEqual(["tool", "version"]);

    // An in-flight run still replays every event.
    const queuedEvents = detail!.runs.find((candidate) => candidate.id === queued.id)!.events ?? [];
    expect(queuedEvents.map((event) => event.kind)).toEqual(["text"]);
  });
});
