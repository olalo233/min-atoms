import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { appendMessage } from "../src/append-message";
import * as schema from "../src/schema";

const client = new PGlite();
const queries: string[] = [];
const db = drizzle(client, {
  schema,
  logger: { logQuery: (query) => { queries.push(query); } },
});
let ownerId: string;
let projectNumber = 0;

beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
  const [owner] = await db.insert(schema.users).values({ username: "test-user", passwordHash: "test-only-hash" }).returning();
  ownerId = owner.id;
}, 30_000);

afterAll(async () => { await client.close(); });

async function createProject() {
  const previewLabel = `ma-test000${++projectNumber}`;
  await db.insert(schema.previewHosts).values({ label: previewLabel });
  const [project] = await db.insert(schema.projects).values({ ownerId, name: "Test", previewLabel }).returning();
  return project.id;
}

const userMessage = { role: "user", mode: "build", content: "Build a counter" } as const;

describe("appendMessage transaction contract", () => {
  test("starts at one, locks the project before allocation, and stores both conversation roles", async () => {
    const projectId = await createProject();
    queries.length = 0;
    const first = await db.transaction((tx) => appendMessage(tx, projectId, userMessage));
    const lockIndex = queries.findIndex((query) => query.includes('from "projects"') && query.includes("for update"));
    const allocationIndex = queries.findIndex((query) => query.includes('max("seq")'));
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(allocationIndex).toBeGreaterThan(lockIndex);
    expect(first).toMatchObject({ projectId, seq: 1, ...userMessage, runId: null, versionId: null });

    const [run] = await db.insert(schema.runs).values({ projectId, userMessageId: first.id, mode: "build", status: "succeeded" }).returning();
    const [version] = await db.insert(schema.versions).values({ projectId, number: 1, commitSha: "a".repeat(40), summary: "Counter", runId: run.id }).returning();
    const reply = { role: "assistant", mode: "build", content: "Done", runId: run.id, versionId: version.id } as const;
    const second = await db.transaction((tx) => appendMessage(tx, projectId, reply));
    expect(second).toMatchObject({ seq: 2, ...reply });
    expect(await db.select().from(schema.messages).where(eq(schema.messages.projectId, projectId))).toHaveLength(2);
  });

  test("allocates from max(seq), scoped to each project", async () => {
    const projectId = await createProject();
    const otherProjectId = await createProject();
    await db.insert(schema.messages).values({ projectId, seq: 7, ...userMessage });
    expect((await db.transaction((tx) => appendMessage(tx, projectId, userMessage))).seq).toBe(8);
    expect((await db.transaction((tx) => appendMessage(tx, otherProjectId, { role: "user", mode: "chat", content: "Discuss" }))).seq).toBe(1);
  });

  test("a caller rollback removes the message and leaves the next sequence available", async () => {
    const projectId = await createProject();
    await expect(db.transaction(async (tx) => {
      await appendMessage(tx, projectId, userMessage);
      throw new Error("caller failed");
    })).rejects.toThrow("caller failed");
    expect(await db.select().from(schema.messages).where(eq(schema.messages.projectId, projectId))).toHaveLength(0);
    expect((await db.transaction((tx) => appendMessage(tx, projectId, userMessage))).seq).toBe(1);
  });

  test("rejects missing projects without writing any message", async () => {
    await expect(db.transaction((tx) => appendMessage(tx, "00000000-0000-0000-0000-000000000000", userMessage)))
      .rejects.toThrow("Project does not exist.");
  });

  test("the migration enforces unique message sequences and valid modes", async () => {
    const projectId = await createProject();
    await db.transaction((tx) => appendMessage(tx, projectId, userMessage));
    await expect(db.insert(schema.messages).values({ projectId, seq: 1, ...userMessage }).execute()).rejects.toThrow();
    await expect(db.transaction((tx) => appendMessage(tx, projectId, { ...userMessage, mode: "invalid" as never }))).rejects.toThrow();
    expect((await db.transaction((tx) => appendMessage(tx, projectId, userMessage))).seq).toBe(2);
  });
});
