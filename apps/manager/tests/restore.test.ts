import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@min-atoms/db/schema";
import { appendMessage } from "@min-atoms/db";
import { ManagerRestoreResponseSchema } from "@min-atoms/protocol";
import { createManagerStore } from "../src/store";
import { createManager } from "../src/manager";
import { ProjectRuntime } from "../src/runtime";
import { ProjectFiles } from "../src/project-files";
import { createRestoreStore, installRestore } from "../src/restore";
import { DockerProcess, at, auth, id, label, origin, secret } from "./helpers";
import type { CommandResult, RunCommand } from "../src/run-process";

const client = new PGlite();
const db = drizzle(client, { schema });
let ownerId: string;
let counter = 0;

beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url)) });
  const [owner] = await db.insert(schema.users).values({ username: "restore-tests", passwordHash: "test-only" }).returning();
  ownerId = owner.id;
}, 30_000);
afterAll(async () => { await client.close(); });

const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };

async function git(cwd: string, argv: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...argv], { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(`git ${argv.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}

// Commit a full file set as one version and return its commit SHA.
async function snapshot(workspace: string, files: Record<string, string>, message: string): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(workspace, path)), { recursive: true });
    await writeFile(join(workspace, path), content);
  }
  await git(workspace, ["add", "-A"]);
  await git(workspace, ["commit", "-q", "-m", message]);
  return git(workspace, ["rev-parse", "HEAD"]);
}

async function scene(steps: Array<{ files: Record<string, string>; message: string }>) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "t13-restore-"));
  const n = ++counter;
  const previewLabel = label(n);
  await db.insert(schema.previewHosts).values({ label: previewLabel });
  const [project] = await db.insert(schema.projects)
    .values({ id: id(n), ownerId, previewLabel, name: "Restore test" }).returning();
  const workspace = join(root, project.id, "workspace");
  await mkdir(workspace, { recursive: true });
  await git(workspace, ["init", "-q"]);
  await git(workspace, ["config", "user.email", "restore-test@example.com"]);
  await git(workspace, ["config", "user.name", "Restore Test"]);
  await git(workspace, ["config", "commit.gpgsign", "false"]);
  // Same ignores as templates/fullstack: node_modules and .ma stay untracked.
  await writeFile(join(workspace, ".gitignore"), "node_modules\n.ma\n");
  const shas: string[] = [];
  let number = 0;
  for (const step of steps) {
    const commitSha = await snapshot(workspace, step.files, step.message);
    number++;
    shas.push(commitSha);
    await db.insert(schema.versions).values({ projectId: project.id, number, commitSha, summary: `v${number}`, runId: null, screenshot: false });
  }
  const versions = await db.select().from(schema.versions)
    .where(eq(schema.versions.projectId, project.id)).orderBy(schema.versions.number);
  await db.update(schema.projects).set({ currentVersionId: versions.at(-1)!.id }).where(eq(schema.projects.id, project.id));
  const docker = new DockerProcess();
  docker.add({ id: project.id, previewLabel }, root, true);
  const store = createManagerStore(db);
  const now = Date.parse(at);
  const runtime = new ProjectRuntime(store, {
    files: new ProjectFiles(root, { uid: process.getuid!(), gid: process.getgid!() }),
    spawn: docker.spawn, clock: { now: () => now, async sleep() {} }, async ready() { return true; },
  });
  const manager = createManager({ store, runtime, secret, webOrigin: origin, now: () => now });
  const commands: string[][] = [];
  const fail = { match: undefined as undefined | ((argv: string[]) => boolean) };
  const command: RunCommand = async (container, argv): Promise<CommandResult> => {
    commands.push([...argv]);
    if (fail.match?.(argv)) return { exitCode: 1, output: "injected command failure" };
    if (argv[0] === "bun") return { exitCode: 0, output: "" };
    if (container !== project.previewLabel) return { exitCode: 1, output: "wrong container" };
    const child = Bun.spawn(argv, { cwd: workspace, env, stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { exitCode, output: (stdout + stderr).slice(-4000) };
  };
  installRestore(manager, { store: createRestoreStore(db, { now: () => new Date(now) }), command });
  return { root, project, workspace, shas, docker, commands, fail, manager,
    request: (versionId: string) => manager.app.request(`/projects/${project.id}/restore`, {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ versionId }),
    }),
    cleanup: () => rm(root, { recursive: true, force: true }) };
}

const storedVersions = (projectId: string) => db.select().from(schema.versions)
  .where(eq(schema.versions.projectId, projectId)).orderBy(schema.versions.number);
const storedMessages = (projectId: string) => db.select().from(schema.messages)
  .where(eq(schema.messages.projectId, projectId)).orderBy(schema.messages.seq);

test("restore rejects malformed requests, unknown projects and foreign or invalid versions without touching files", async () => {
  const other = await scene([{ files: { "a.txt": "other\n" }, message: "v1" }]);
  const h = await scene([{ files: { "a.txt": "one\n" }, message: "v1" }, { files: { "a.txt": "two\n" }, message: "v2" }]);
  try {
    const foreignVersion = (await storedVersions(other.project.id))[0];
    expect((await h.manager.app.request(`/projects/${h.project.id}/restore`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ versionId: foreignVersion.id }) })).status).toBe(401);
    expect((await h.manager.app.request(`/projects/invalid/restore`, { method: "POST", headers: auth, body: "{}" })).status).toBe(400);
    for (const body of ["{", JSON.stringify({}), JSON.stringify({ versionId: "nope" })]) {
      const response = await h.manager.app.request(`/projects/${h.project.id}/restore`, { method: "POST", headers: auth, body });
      expect(response.status).toBe(400);
    }
    const unknown = await h.manager.app.request(`/projects/${id(999)}/restore`,
      { method: "POST", headers: auth, body: JSON.stringify({ versionId: foreignVersion.id }) });
    expect(unknown.status).toBe(404);
    // A version owned by another project is hidden behind 404, not restored.
    expect((await h.request(foreignVersion.id)).status).toBe(404);
    expect((await h.request(id(998))).status).toBe(404);
    // A corrupted stored SHA is rejected before any container command runs.
    const [corrupt] = await db.insert(schema.versions).values({ projectId: h.project.id, number: 90,
      commitSha: "not-a-sha", summary: "corrupt", runId: null, screenshot: false }).returning();
    expect((await h.request(corrupt.id)).status).toBe(409);
    expect(h.commands).toEqual([]);
    expect(h.fail.match).toBeUndefined();
    expect(await readFile(join(h.workspace, "a.txt"), "utf8")).toBe("two\n");
  } finally { await h.cleanup(); await other.cleanup(); }
});

test("restore rejects queued and running work with 409 before touching files", async () => {
  const h = await scene([{ files: { "a.txt": "one\n" }, message: "v1" }, { files: { "a.txt": "two\n" }, message: "v2" }]);
  try {
    for (const status of ["queued", "running"] as const) {
      const run = await db.transaction(async tx => {
        const message = await appendMessage(tx, h.project.id, { role: "user", mode: "build", content: "go", runId: null, versionId: null });
        const [created] = await tx.insert(schema.runs).values({ projectId: h.project.id, userMessageId: message.id,
          mode: "build", status, startedAt: status === "running" ? new Date(at) : null }).returning();
        return created;
      });
      const versions = await storedVersions(h.project.id);
      const response = await h.request(versions[0].id);
      expect(response.status).toBe(409);
      expect(await storedVersions(h.project.id)).toHaveLength(2);
      expect(h.commands).toEqual([]);
      expect(await readFile(join(h.workspace, "a.txt"), "utf8")).toBe("two\n");
      await db.update(schema.runs).set({ status: "cancelled" }).where(eq(schema.runs.id, run.id));
    }
    expect((await db.select().from(schema.projects).where(eq(schema.projects.id, h.project.id)))[0].currentVersionId)
      .toBe((await storedVersions(h.project.id)).at(-1)!.id);
  } finally { await h.cleanup(); }
});

test("restore creates a new linear version equal to the target tree and persists the assistant message", async () => {
  const h = await scene([
    { files: { "src/app.ts": "one\n", "package.json": "{ \"name\": \"app\" }\n" }, message: "v1" },
    { files: { "src/app.ts": "two\n" }, message: "v2" },
    { files: { "src/app.ts": "three\n" }, message: "v3" },
  ]);
  try {
    // An untracked file is cleaned; excluded directories survive.
    await mkdir(join(h.workspace, "node_modules"), { recursive: true });
    await writeFile(join(h.workspace, "node_modules", "keep.txt"), "keep\n");
    await writeFile(join(h.workspace, "junk.txt"), "junk\n");
    const response = await h.request((await storedVersions(h.project.id))[0].id);
    expect(response.status).toBe(200);
    const created = ManagerRestoreResponseSchema.parse(await response.json());
    expect(created).toMatchObject({ projectId: h.project.id, number: 4, summary: "恢复到版本 1",
      runId: null, screenshot: false });
    expect(created.commitSha).toMatch(/^[0-9a-f]{40}$/);

    // Exact, argv-safe command order in the owned container; package.json is
    // unchanged so `bun install` must not run.
    const sha1 = h.shas[0];
    expect(h.commands).toEqual([
      ["git", "cat-file", "-e", `${sha1}^{commit}`],
      ["git", "hash-object", "package.json"],
      ["git", "restore", `--source=${sha1}`, "--staged", "--worktree", "--", "."],
      ["git", "clean", "-fd", "-e", "node_modules", "-e", ".ma"],
      ["git", "hash-object", "package.json"],
      ["git", "add", "-A"],
      ["git", "commit", "--allow-empty", "-m", "restore v1"],
      ["git", "rev-parse", "HEAD"],
      ["git", "rev-parse", "HEAD^{tree}"],
      ["git", "rev-parse", `${sha1}^{tree}`],
    ]);

    // Real repository state: new linear commit whose tree equals v1's tree.
    expect(created.commitSha).toBe(await git(h.workspace, ["rev-parse", "HEAD"]));
    expect(await git(h.workspace, ["rev-parse", "HEAD^{tree}"])).toBe(await git(h.workspace, ["rev-parse", `${sha1}^{tree}`]));
    expect(await git(h.workspace, ["rev-parse", "HEAD^"])).toBe(h.shas[2]);
    expect(await readFile(join(h.workspace, "src/app.ts"), "utf8")).toBe("one\n");
    expect(await Bun.file(join(h.workspace, "junk.txt")).exists()).toBe(false);
    expect(await readFile(join(h.workspace, "node_modules", "keep.txt"), "utf8")).toBe("keep\n");
    expect(await git(h.workspace, ["status", "--porcelain"])).toBe("");

    // Version row, current pointer and restore message persisted in one commit.
    const versions = await storedVersions(h.project.id);
    expect(versions.map(version => [version.number, version.runId, version.summary])).toEqual([
      [1, null, "v1"], [2, null, "v2"], [3, null, "v3"], [4, null, "恢复到版本 1"],
    ]);
    expect((await db.select().from(schema.projects).where(eq(schema.projects.id, h.project.id)))[0].currentVersionId).toBe(created.id);
    const messages = await storedMessages(h.project.id);
    expect(messages.at(-1)).toMatchObject({ role: "assistant", mode: "build", content: "已恢复到版本 1",
      runId: null, versionId: created.id });
    // Detail reload reads the persisted message back from the database.
    expect((await db.select().from(schema.messages).where(eq(schema.messages.projectId, h.project.id))
      .orderBy(sql`${schema.messages.seq} desc`).limit(1))[0].content).toBe("已恢复到版本 1");
  } finally { await h.cleanup(); }
});

test("restore runs bun install only when package.json changed", async () => {
  const h = await scene([
    { files: { "package.json": "{ \"name\": \"one\" }\n", "src/app.ts": "one\n" }, message: "v1" },
    { files: { "package.json": "{ \"name\": \"two\" }\n", "src/app.ts": "two\n" }, message: "v2" },
  ]);
  try {
    const response = await h.request((await storedVersions(h.project.id))[0].id);
    expect(response.status).toBe(200);
    const install = h.commands.findIndex(argv => argv[0] === "bun");
    expect(h.commands[install]).toEqual(["bun", "install"]);
    expect(h.commands[install - 1]).toEqual(["git", "hash-object", "package.json"]);
    expect(h.commands[install + 1]).toEqual(["git", "add", "-A"]);
    expect(await readFile(join(h.workspace, "package.json"), "utf8")).toBe("{ \"name\": \"one\" }\n");
    const created = ManagerRestoreResponseSchema.parse(await response.json());
    expect(await git(h.workspace, ["rev-parse", "HEAD^{tree}"])).toBe(await git(h.workspace, ["rev-parse", `${h.shas[0]}^{tree}`]));
    expect(created.commitSha).toBe(await git(h.workspace, ["rev-parse", "HEAD"]));
  } finally { await h.cleanup(); }
});

test("restore rolls back the version and message when a container command fails", async () => {
  const h = await scene([{ files: { "a.txt": "one\n" }, message: "v1" }, { files: { "a.txt": "two\n" }, message: "v2" }]);
  try {
    h.fail.match = argv => argv[0] === "git" && argv[1] === "restore";
    const response = await h.request((await storedVersions(h.project.id))[0].id);
    expect(response.status).toBe(503);
    expect(await storedVersions(h.project.id)).toHaveLength(2);
    expect((await storedMessages(h.project.id)).filter(message => message.role === "assistant")).toEqual([]);
    expect((await db.select().from(schema.projects).where(eq(schema.projects.id, h.project.id)))[0].currentVersionId)
      .toBe((await storedVersions(h.project.id))[1].id);
  } finally { await h.cleanup(); }
});

test("restore rolls back the version and message when the database write fails", async () => {
  const h = await scene([{ files: { "a.txt": "one\n" }, message: "v1" }, { files: { "a.txt": "two\n" }, message: "v2" }]);
  try {
    await db.execute(sql`create function reject_restore_message() returns trigger language plpgsql as $$
      begin if NEW.role = 'assistant' then raise exception 'test restore message failure'; end if; return NEW; end; $$`);
    await db.execute(sql`create trigger reject_restore before insert on messages for each row execute function reject_restore_message()`);
    const response = await h.request((await storedVersions(h.project.id))[0].id);
    expect(response.status).toBe(503);
    // Files were restored by the container commands, but nothing was persisted.
    expect(await storedVersions(h.project.id)).toHaveLength(2);
    expect((await storedMessages(h.project.id)).filter(message => message.role === "assistant")).toEqual([]);
    expect((await db.select().from(schema.projects).where(eq(schema.projects.id, h.project.id)))[0].currentVersionId)
      .toBe((await storedVersions(h.project.id))[1].id);
  } finally {
    await db.execute(sql`drop trigger if exists reject_restore on messages`);
    await db.execute(sql`drop function if exists reject_restore_message()`);
    await h.cleanup();
  }
});
