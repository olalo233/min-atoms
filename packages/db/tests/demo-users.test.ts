import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import bcrypt from "bcryptjs";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import type { Database } from "../src/client";
import { seedDemoUsers, unsuspendUser } from "../src/demo-users";
import * as schema from "../src/schema";

const client = new PGlite();
const db = drizzle(client, { schema });
const writer = db as unknown as Database;
let directory: string;
let filename: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "ma-fake-users-"));
  filename = join(directory, "users.txt");
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
}, 30_000);
afterAll(async () => { await client.close(); await rm(directory, { recursive: true, force: true }); });

test("migration enables screening event RLS without policies or forced owner restrictions", async () => {
  const { rows } = await client.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(`
    SELECT relrowsecurity, relforcerowsecurity
    FROM pg_class
    WHERE oid = 'public.screening_events'::regclass
  `);
  expect(rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: false }]);
  const { rows: policies } = await client.query(`
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'screening_events'
  `);
  expect(policies).toHaveLength(0);
});

describe("demo account seed and unsuspend", () => {
  test("upserts a temporary users file, preserves IDs, projects, absent users and suspension", async () => {
    const [existing] = await db.insert(schema.users).values({ username: "existing", passwordHash: "old", suspendedAt: new Date(), suspendedReason: "test" }).returning();
    const [retained] = await db.insert(schema.users).values({ username: "retained", passwordHash: "retained" }).returning();
    await db.insert(schema.previewHosts).values({ label: "ma-aaaa1111" });
    const [project] = await db.insert(schema.projects).values({ name: "Existing project", ownerId: existing.id, previewLabel: "ma-aaaa1111" }).returning();
    await writeFile(filename, "# fake test accounts\nexisting:fake-password-one\ninvitee:fake:password:two\n");
    const oldEnv = process.env.MA_DEMO_USERS_FILE;
    process.env.MA_DEMO_USERS_FILE = filename;
    try { expect(await db.transaction((tx) => seedDemoUsers(tx as unknown as Database))).toBe(2); }
    finally {
      if (oldEnv === undefined) delete process.env.MA_DEMO_USERS_FILE;
      else process.env.MA_DEMO_USERS_FILE = oldEnv;
    }
    const rows = await db.select().from(schema.users);
    const updated = rows.find((row) => row.username === "existing")!;
    const invited = rows.find((row) => row.username === "invitee")!;
    expect(rows).toHaveLength(3);
    expect(updated.id).toBe(existing.id);
    expect(updated.suspendedAt).not.toBeNull();
    expect(rows.find((row) => row.id === retained.id)?.passwordHash).toBe("retained");
    expect(await bcrypt.compare("fake-password-one", updated.passwordHash)).toBe(true);
    expect(await bcrypt.compare("fake:password:two", invited.passwordHash)).toBe(true);
    expect(await db.select().from(schema.projects)).toEqual([project]);
    await writeFile(filename, "existing:replacement-fake-password\ninvitee:fake:password:two");
    await db.transaction((tx) => seedDemoUsers(tx as unknown as Database, filename));
    const [again] = await db.select().from(schema.users).where(eq(schema.users.id, existing.id));
    expect(await bcrypt.compare("replacement-fake-password", again.passwordHash)).toBe(true);
    expect(await db.select().from(schema.users)).toHaveLength(3);
  }, 15_000);
  test("invalid account files are rejected before any upsert", async () => {
    const before = await db.select().from(schema.users);
    for (const invalid of ["valid:fake\nbad-line", "duplicate:fake\nduplicate:fake", "# empty", "blank:"]) {
      await writeFile(filename, invalid);
      await expect(seedDemoUsers(writer, filename)).rejects.toThrow("Demo users file");
      expect(await db.select().from(schema.users)).toEqual(before);
    }
  });
  test("unsuspend clears only the named account fields and leaves history intact", async () => {
    const [other] = await db.insert(schema.users).values({ username: "other-suspended", passwordHash: "fake", suspendedAt: new Date(), suspendedReason: "test" }).returning();
    const [existing] = await db.select().from(schema.users).where(eq(schema.users.username, "existing"));
    await db.insert(schema.screeningEvents).values({ userId: existing.id, kind: "new_project", category: "phishing", scores: { harmful_app: 1, platform_attack: 0 }, excerpt: "fake" });
    expect(await unsuspendUser(writer, "existing")).toBe(true);
    expect(await unsuspendUser(writer, "missing")).toBe(false);
    const [updated] = await db.select().from(schema.users).where(eq(schema.users.id, existing.id));
    expect(updated.suspendedAt).toBeNull();
    expect(updated.suspendedReason).toBeNull();
    expect((await db.select().from(schema.users).where(eq(schema.users.id, other.id)))[0].suspendedAt).not.toBeNull();
    expect(await db.select().from(schema.screeningEvents)).toHaveLength(1);
    expect(await db.select().from(schema.projects)).toHaveLength(1);
  });
});
