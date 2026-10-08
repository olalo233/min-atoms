import { PGlite } from "@electric-sql/pglite";
import type { User } from "@min-atoms/db";
import * as schema from "@min-atoms/db/schema";
import { eq } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";

/**
 * Route tests run against a real PostgreSQL (embedded PGlite) with a fake
 * manager, fake session, and fake `after()`. State lives on globalThis so the
 * `vi.mock` factories (which are hoisted above imports) can reach it.
 */
export const HARNESS_KEY = "__minAtomsWebApiHarness";

export type TestDatabase = PgliteDatabase<typeof schema>;

export type FakeManager = {
  ensure: ReturnType<typeof vi.fn>;
  kick: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
  removeProject: ReturnType<typeof vi.fn>;
  screenshot: ReturnType<typeof vi.fn>;
  streamUrl: ReturnType<typeof vi.fn>;
  health: ReturnType<typeof vi.fn>;
};

export type Harness = {
  client: PGlite | null;
  db: TestDatabase | null;
  user: User | null;
  manager: FakeManager;
  scheduled: Array<() => Promise<void>>;
};

const MIGRATIONS_FOLDER = fileURLToPath(
  new URL("../../../../packages/db/migrations", import.meta.url),
);

function emptyManager(): FakeManager {
  return {
    ensure: vi.fn(),
    kick: vi.fn(),
    abort: vi.fn(),
    restore: vi.fn(),
    removeProject: vi.fn(),
    screenshot: vi.fn(),
    streamUrl: vi.fn(
      (projectId: string, token: string) =>
        `https://manager.test/projects/${projectId}/stream?token=${encodeURIComponent(token)}`,
    ),
    health: vi.fn(),
  };
}

export function harness(): Harness {
  const holder = globalThis as unknown as Record<string, Harness | undefined>;
  const existing = holder[HARNESS_KEY];
  if (existing) {
    return existing;
  }
  const created: Harness = {
    client: null,
    db: null,
    user: null,
    manager: emptyManager(),
    scheduled: [],
  };
  holder[HARNESS_KEY] = created;
  return created;
}

export function setCurrentUser(user: User | null): void {
  harness().user = user;
}

/** The fake manager the routes receive instead of a real HTTP client. */
export function fakeManager(): FakeManager {
  return harness().manager;
}

export function testDb(): TestDatabase {
  const db = harness().db;
  if (!db) {
    throw new Error("The test database has not been started.");
  }
  return db;
}

export async function startDatabase(): Promise<void> {
  const state = harness();
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  state.client = client;
  state.db = db;
}

export async function stopDatabase(): Promise<void> {
  await harness().client?.close();
}

/** Each test starts from an empty database, including the preview host pool. */
export async function truncateDatabase(): Promise<void> {
  await harness().client?.exec(
    "truncate table users, preview_hosts, projects, messages, runs, run_events, versions restart identity cascade",
  );
}

/** Re-arms the fake manager and clears deferred tasks after vitest restores mocks. */
export function resetHarness(user: User | null): void {
  const state = harness();
  state.scheduled = [];
  state.user = user;
  state.manager = emptyManager();
  state.manager.ensure.mockResolvedValue(undefined);
  state.manager.kick.mockResolvedValue(undefined);
  state.manager.abort.mockResolvedValue(undefined);
  state.manager.removeProject.mockResolvedValue(undefined);
  state.manager.restore.mockResolvedValue({});
  state.manager.screenshot.mockResolvedValue(
    new Response(new Uint8Array([137, 80, 78, 71]), {
      status: 200,
      headers: { "content-type": "image/png" },
    }),
  );
  state.manager.health.mockResolvedValue(true);
}

/** Runs the tasks that `after()` deferred, in order. */
export async function runScheduledTasks(): Promise<void> {
  const state = harness();
  const tasks = [...state.scheduled];
  state.scheduled = [];
  for (const task of tasks) {
    await task();
  }
}

let userCounter = 0;

export async function seedUser(username = `user-${++userCounter}`): Promise<User> {
  const [user] = await testDb()
    .insert(schema.users)
    .values({ username, passwordHash: "test-only-hash" })
    .returning();
  return user;
}

export async function seedPreviewHosts(labels: string[]): Promise<void> {
  await testDb().insert(schema.previewHosts).values(labels.map((label) => ({ label })));
}

export async function seedVersion(input: {
  projectId: string;
  number: number;
  commitSha?: string;
  summary?: string;
  runId?: string | null;
  screenshot?: boolean;
}): Promise<schema.Version> {
  const [version] = await testDb()
    .insert(schema.versions)
    .values({
      projectId: input.projectId,
      number: input.number,
      commitSha: input.commitSha ?? "a".repeat(40),
      summary: input.summary ?? `Version ${input.number}`,
      runId: input.runId ?? null,
      screenshot: input.screenshot ?? false,
    })
    .returning();
  return version;
}

export async function setCurrentVersion(projectId: string, versionId: string): Promise<void> {
  await testDb()
    .update(schema.projects)
    .set({ currentVersionId: versionId })
    .where(eq(schema.projects.id, projectId));
}

export async function seedMessage(input: {
  projectId: string;
  seq: number;
  role?: "user" | "assistant";
  mode?: "chat" | "build";
  content?: string;
  runId?: string | null;
  versionId?: string | null;
}): Promise<schema.Message> {
  const [message] = await testDb()
    .insert(schema.messages)
    .values({
      projectId: input.projectId,
      seq: input.seq,
      role: input.role ?? "user",
      mode: input.mode ?? "build",
      content: input.content ?? `Message ${input.seq}`,
      runId: input.runId ?? null,
      versionId: input.versionId ?? null,
    })
    .returning();
  return message;
}

export async function seedRun(input: {
  projectId: string;
  userMessageId: string;
  mode?: "chat" | "build";
  status?: schema.Run["status"];
  error?: string | null;
}): Promise<schema.Run> {
  const [run] = await testDb()
    .insert(schema.runs)
    .values({
      projectId: input.projectId,
      userMessageId: input.userMessageId,
      mode: input.mode ?? "build",
      status: input.status ?? "queued",
      error: input.error ?? null,
    })
    .returning();
  return run;
}

export async function seedRunEvent(input: {
  projectId: string;
  runId: string;
  seq: number;
  kind: string;
  payload: Record<string, unknown>;
}): Promise<schema.RunEventRecord> {
  const [event] = await testDb()
    .insert(schema.runEvents)
    .values({
      projectId: input.projectId,
      runId: input.runId,
      seq: input.seq,
      kind: input.kind,
      payload: input.payload,
    })
    .returning();
  return event;
}

/** Creates an owned project with a claimed preview host, mirroring POST /api/projects. */
export async function seedProject(input: {
  ownerId: string;
  name?: string;
  previewLabel: string;
}): Promise<schema.Project> {
  const [project] = await testDb()
    .insert(schema.projects)
    .values({ ownerId: input.ownerId, name: input.name ?? "Test project", previewLabel: input.previewLabel })
    .returning();
  await testDb()
    .update(schema.previewHosts)
    .set({ projectId: project.id })
    .where(eq(schema.previewHosts.label, input.previewLabel));
  return project;
}
