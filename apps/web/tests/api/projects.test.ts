import { WebCreateProjectResponseSchema, WebProjectDetailResponseSchema, WebProjectListResponseSchema } from "@min-atoms/protocol";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/db/client", async () => {
  const { testDb } = await import("./harness");
  return { getDb: () => testDb(), closeDatabase: async () => {} };
});

vi.mock("@/lib/auth/session", async () => {
  const { harness } = await import("./harness");
  return { getCurrentUser: async () => harness().user };
});

vi.mock("@/lib/server/after", async () => {
  const { harness } = await import("./harness");
  return {
    runAfterResponse: (task: () => Promise<void>) => {
      harness().scheduled.push(task);
    },
  };
});

vi.mock("@/lib/server/manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/manager")>();
  const { harness } = await import("./harness");
  return { ...actual, getManagerClient: () => harness().manager };
});

import * as schema from "@min-atoms/db/schema";

import { DELETE, GET as getProject } from "@/app/api/projects/[id]/route";
import { POST as createMessage } from "@/app/api/projects/[id]/messages/route";
import { GET as listProjects, POST as createProject } from "@/app/api/projects/route";
import { ManagerError, MANAGER_TIMEOUTS } from "@/lib/server/manager";

import {
  fakeManager,
  resetHarness,
  runScheduledTasks,
  seedMessage,
  seedPreviewHosts,
  seedProject,
  seedRun,
  seedRunEvent,
  seedUser,
  seedVersion,
  setCurrentUser,
  setCurrentVersion,
  startDatabase,
  stopDatabase,
  testDb,
  truncateDatabase,
} from "./harness";

function jsonRequest(url: string, method: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function projectRequest(id: string) {
  return { params: Promise.resolve({ id }) };
}

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

describe("POST /api/projects", () => {
  test("claims a preview host, queues the first build run, and defers the kick", async () => {
    const user = await seedUser();
    await seedPreviewHosts(["ma-aaaa1111", "ma-bbbb2222"]);
    setCurrentUser(user);

    const prompt = "Build a programmer calculator with hexadecimal, octal and binary display plus bitwise operators";
    const response = await createProject(
      jsonRequest("http://localhost/api/projects", "POST", { prompt }),
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(WebCreateProjectResponseSchema.safeParse(body).success).toBe(true);

    const [project] = await testDb()
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, body.id));
    expect(project).toMatchObject({
      ownerId: user.id,
      name: prompt.slice(0, 24),
      previewLabel: "ma-aaaa1111",
      currentVersionId: null,
    });

    const [host] = await testDb()
      .select()
      .from(schema.previewHosts)
      .where(eq(schema.previewHosts.label, "ma-aaaa1111"));
    expect(host.projectId).toBe(project.id);

    const messages = await testDb()
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.projectId, project.id));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ seq: 1, role: "user", mode: "build", content: prompt, versionId: null });

    const runs = await testDb().select().from(schema.runs).where(eq(schema.runs.projectId, project.id));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "queued", mode: "build", userMessageId: messages[0].id });
    expect(messages[0].runId).toBe(runs[0].id);

    // The response is not held open for the manager: kick runs after it.
    expect(fakeManager().kick).not.toHaveBeenCalled();
    await runScheduledTasks();
    expect(fakeManager().kick).toHaveBeenCalledWith(body.id, "ma-aaaa1111", MANAGER_TIMEOUTS.kick);
  });

  test("rejects a blank prompt before touching the preview pool", async () => {
    setCurrentUser(await seedUser());
    await seedPreviewHosts(["ma-aaaa1111"]);

    const response = await createProject(
      jsonRequest("http://localhost/api/projects", "POST", { prompt: "   " }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.any(String) });
    expect(await testDb().select().from(schema.projects)).toHaveLength(0);
    expect((await testDb().select().from(schema.previewHosts))[0].projectId).toBeNull();
  });

  test("reports an exhausted preview pool instead of creating a half project", async () => {
    const owner = await seedUser();
    setCurrentUser(owner);
    await seedPreviewHosts(["ma-aaaa1111"]);
    await seedProject({ ownerId: owner.id, previewLabel: "ma-aaaa1111" });

    const response = await createProject(
      jsonRequest("http://localhost/api/projects", "POST", { prompt: "A todo list" }),
    );

    expect(response.status).toBe(503);
    expect(await testDb().select().from(schema.projects)).toHaveLength(1);
  });

  test("requires a session", async () => {
    const response = await createProject(
      jsonRequest("http://localhost/api/projects", "POST", { prompt: "A todo list" }),
    );
    expect(response.status).toBe(401);
  });
});

describe("GET /api/projects", () => {
  test("lists only the signed-in owner's projects with version and run facts", async () => {
    const owner = await seedUser();
    const other = await seedUser();
    await seedPreviewHosts(["ma-aaaa1111", "ma-bbbb2222", "ma-cccc3333"]);

    const own = await seedProject({ ownerId: owner.id, previewLabel: "ma-aaaa1111", name: "Mine" });
    const otherProject = await seedProject({ ownerId: other.id, previewLabel: "ma-bbbb2222", name: "Theirs" });
    const empty = await seedProject({ ownerId: owner.id, previewLabel: "ma-cccc3333", name: "Empty" });

    const version = await seedVersion({ projectId: own.id, number: 2, commitSha: "c".repeat(40), screenshot: true });
    await seedVersion({ projectId: own.id, number: 1, commitSha: "d".repeat(40), screenshot: false });
    await setCurrentVersion(own.id, version.id);

    const message = await seedMessage({ projectId: own.id, seq: 1 });
    await seedRun({ projectId: own.id, userMessageId: message.id, status: "running" });

    setCurrentUser(owner);
    const response = await listProjects();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(WebProjectListResponseSchema.safeParse(body).success).toBe(true);
    expect(body.map((summary: { name: string }) => summary.name).sort()).toEqual(["Empty", "Mine"]);

    const mine = body.find((summary: { id: string }) => summary.id === own.id);
    expect(mine).toMatchObject({
      hasRunningRun: true,
      latestVersionNumber: 2,
      currentScreenshotSha: "c".repeat(40),
    });
    const emptySummary = body.find((summary: { id: string }) => summary.id === empty.id);
    expect(emptySummary).toMatchObject({
      hasRunningRun: false,
      latestVersionNumber: null,
      currentScreenshotSha: null,
    });
    expect(body.some((summary: { id: string }) => summary.id === otherProject.id)).toBe(false);
  });

  test("requires a session", async () => {
    await expect(listProjects().then((response) => response.status)).resolves.toBe(401);
  });
});

describe("GET /api/projects/:id", () => {
  test("returns messages, runs, versions and the SSE cursor for the owner", async () => {
    const owner = await seedUser();
    await seedPreviewHosts(["ma-aaaa1111"]);
    const project = await seedProject({ ownerId: owner.id, previewLabel: "ma-aaaa1111", name: "Calculator" });

    const message = await seedMessage({ projectId: project.id, seq: 1, content: "Build a calculator" });
    const finished = await seedRun({ projectId: project.id, userMessageId: message.id, status: "succeeded" });
    const active = await seedRun({ projectId: project.id, userMessageId: message.id, status: "running" });
    const version = await seedVersion({ projectId: project.id, number: 1, runId: finished.id, screenshot: true });
    await setCurrentVersion(project.id, version.id);

    await seedRunEvent({ projectId: project.id, runId: finished.id, seq: 1, kind: "text", payload: { delta: "Working" } });
    await seedRunEvent({
      projectId: project.id,
      runId: finished.id,
      seq: 2,
      kind: "tool",
      payload: { phase: "end", toolCallId: "tool-1", name: "read_file", title: "读取 src/App.tsx", ok: true },
    });
    await seedRunEvent({
      projectId: project.id,
      runId: finished.id,
      seq: 3,
      kind: "version",
      payload: { versionId: version.id, number: 1, commitSha: version.commitSha, summary: "Version 1" },
    });
    await seedRunEvent({ projectId: project.id, runId: active.id, seq: 1, kind: "text", payload: { delta: "Streaming" } });
    const last = await seedRunEvent({
      projectId: project.id,
      runId: active.id,
      seq: 2,
      kind: "thinking",
      payload: { delta: "Considering" },
    });

    setCurrentUser(owner);
    const response = await getProject(new Request("http://localhost/api/projects/x"), projectRequest(project.id));

    expect(response.status).toBe(200);
    const detail = await response.json();
    expect(WebProjectDetailResponseSchema.safeParse(detail).success).toBe(true);
    expect(detail).toMatchObject({ id: project.id, name: "Calculator", previewLabel: "ma-aaaa1111" });
    expect(detail.messages).toHaveLength(1);
    expect(detail.versions).toHaveLength(1);
    expect(detail.lastEventId).toBe(last.id);

    // A finished run keeps only tool/version/error; the prose comes from messages.
    const finishedRun = detail.runs.find((run: { id: string }) => run.id === finished.id);
    expect(finishedRun.status).toBe("succeeded");
    expect(finishedRun.events.map((event: { kind: string }) => event.kind)).toEqual(["tool", "version"]);

    // An in-flight run replays every event, including text and thinking.
    const activeRun = detail.runs.find((run: { id: string }) => run.id === active.id);
    expect(activeRun.events.map((event: { kind: string }) => event.kind)).toEqual(["text", "thinking"]);
  });

  test("hides another owner's project behind a 404", async () => {
    const owner = await seedUser();
    const intruder = await seedUser();
    await seedPreviewHosts(["ma-aaaa1111"]);
    const project = await seedProject({ ownerId: owner.id, previewLabel: "ma-aaaa1111" });

    setCurrentUser(intruder);
    const response = await getProject(new Request("http://localhost/api/projects/x"), projectRequest(project.id));

    expect(response.status).toBe(404);
    expect(await testDb().select().from(schema.projects)).toHaveLength(1);
  });
});

describe("DELETE /api/projects/:id", () => {
  async function ownedProject() {
    const owner = await seedUser();
    await seedPreviewHosts(["ma-aaaa1111"]);
    const project = await seedProject({ ownerId: owner.id, previewLabel: "ma-aaaa1111" });
    const message = await seedMessage({ projectId: project.id, seq: 1 });
    return { owner, project, message };
  }

  test("deletes the project, its history, and returns the preview host to the pool", async () => {
    const { owner, project, message } = await ownedProject();
    const run = await seedRun({ projectId: project.id, userMessageId: message.id, status: "succeeded" });
    const version = await seedVersion({ projectId: project.id, number: 1, runId: run.id });
    await seedRunEvent({
      projectId: project.id,
      runId: run.id,
      seq: 1,
      kind: "version",
      payload: { versionId: version.id, number: 1, commitSha: version.commitSha, summary: "v1" },
    });
    setCurrentUser(owner);

    const response = await DELETE(new Request("http://localhost/api/projects/x"), projectRequest(project.id));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({});
    expect(fakeManager().removeProject).toHaveBeenCalledWith(project.id, MANAGER_TIMEOUTS.removeProject);
    expect(await testDb().select().from(schema.projects)).toHaveLength(0);
    expect(await testDb().select().from(schema.messages)).toHaveLength(0);
    expect(await testDb().select().from(schema.runEvents)).toHaveLength(0);
    expect(await testDb().select().from(schema.versions)).toHaveLength(0);

    const [host] = await testDb()
      .select()
      .from(schema.previewHosts)
      .where(eq(schema.previewHosts.label, "ma-aaaa1111"));
    expect(host.projectId).toBeNull();
  });

  test("refuses while a run is queued or running", async () => {
    const { owner, project, message } = await ownedProject();
    await seedRun({ projectId: project.id, userMessageId: message.id, status: "queued" });
    setCurrentUser(owner);

    const response = await DELETE(new Request("http://localhost/api/projects/x"), projectRequest(project.id));

    expect(response.status).toBe(409);
    expect(fakeManager().removeProject).not.toHaveBeenCalled();
    expect(await testDb().select().from(schema.projects)).toHaveLength(1);
    expect(await testDb().select().from(schema.runs)).toHaveLength(1);
  });

  test("refuses another owner's project without deleting anything", async () => {
    const { project } = await ownedProject();
    setCurrentUser(await seedUser());

    const response = await DELETE(new Request("http://localhost/api/projects/x"), projectRequest(project.id));

    expect(response.status).toBe(404);
    expect(fakeManager().removeProject).not.toHaveBeenCalled();
    expect(await testDb().select().from(schema.projects)).toHaveLength(1);
  });

  test("keeps the database rows when the manager cannot take the delete", async () => {
    const { owner, project } = await ownedProject();
    setCurrentUser(owner);
    fakeManager().removeProject.mockRejectedValue(new ManagerError("unavailable", null));

    const response = await DELETE(new Request("http://localhost/api/projects/x"), projectRequest(project.id));

    expect(response.status).toBe(502);
    expect(await testDb().select().from(schema.projects)).toHaveLength(1);
    const [host] = await testDb()
      .select()
      .from(schema.previewHosts)
      .where(eq(schema.previewHosts.label, "ma-aaaa1111"));
    expect(host.projectId).toBe(project.id);
  });

  test("still removes the project when the manager has already forgotten it", async () => {
    const { owner, project } = await ownedProject();
    setCurrentUser(owner);
    fakeManager().removeProject.mockRejectedValue(new ManagerError("not found", 404));

    const response = await DELETE(new Request("http://localhost/api/projects/x"), projectRequest(project.id));

    expect(response.status).toBe(200);
    expect(await testDb().select().from(schema.projects)).toHaveLength(0);
  });

  test("a message racing the delete is never accepted and then cascaded away", async () => {
    const { owner, project } = await ownedProject();
    setCurrentUser(owner);

    // Hold the delete open while the manager "removes" the project, the window in
    // which a concurrent POST used to slip a queued run past the active-run check.
    let releaseManager!: () => void;
    const managerGate = new Promise<void>((resolve) => {
      releaseManager = resolve;
    });
    let managerEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      managerEntered = resolve;
    });
    fakeManager().removeProject.mockImplementation(async () => {
      managerEntered();
      await managerGate;
    });

    const deleting = DELETE(new Request("http://localhost/api/projects/x"), projectRequest(project.id));
    await entered;

    const posting = createMessage(
      jsonRequest("http://localhost/api/projects/x/messages", "POST", { content: "Race the delete", mode: "build" }),
      { params: Promise.resolve({ id: project.id }) },
    );
    // The message write is serialized behind the delete's project row lock.
    const race = await Promise.race([
      posting.then(() => "settled" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 50)),
    ]);
    expect(race).toBe("blocked");

    releaseManager();
    const deleteResponse = await deleting;
    const postResponse = await posting;

    expect(deleteResponse.status).toBe(200);
    // The project is gone by the time the message write proceeds, so it is
    // rejected outright instead of being stored and silently deleted.
    expect(postResponse.status).toBe(404);
    expect(await testDb().select().from(schema.messages)).toHaveLength(0);
    expect(await testDb().select().from(schema.runs)).toHaveLength(0);
  });
});
