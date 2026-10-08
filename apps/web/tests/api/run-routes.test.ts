import {
  WebCreateMessageResponseSchema,
  WebRestoreVersionResponseSchema,
  WebStopRunResponseSchema,
  WebStreamTokenResponseSchema,
  WebVmResponseSchema,
  verifySseToken,
} from "@min-atoms/protocol";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

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

import { POST as ensureProject } from "@/app/api/projects/[id]/ensure/route";
import { POST as createMessage } from "@/app/api/projects/[id]/messages/route";
import { POST as stopRun } from "@/app/api/projects/[id]/runs/[runId]/stop/route";
import { GET as getScreenshot } from "@/app/api/projects/[id]/shots/[sha]/route";
import { GET as getStreamToken } from "@/app/api/projects/[id]/stream-token/route";
import { POST as restoreVersion } from "@/app/api/projects/[id]/versions/[versionId]/restore/route";
import { GET as getVm } from "@/app/api/vm/route";
import { ManagerError, MANAGER_TIMEOUTS } from "@/lib/server/manager";
import { resetVmCacheForTests, VM_STATUS_CACHE_MS } from "@/lib/server/vm";

import {
  fakeManager,
  resetHarness,
  runScheduledTasks,
  seedMessage,
  seedPreviewHosts,
  seedProject,
  seedRun,
  seedUser,
  seedVersion,
  setCurrentUser,
  startDatabase,
  stopDatabase,
  testDb,
  truncateDatabase,
} from "./harness";

const SHARED_SECRET = "test-shared-secret";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
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
  resetVmCacheForTests();
  process.env.MA_SHARED_SECRET = SHARED_SECRET;
  process.env.MANAGER_URL = "https://ma-vm.expii.top";
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.MA_SHARED_SECRET;
  delete process.env.MANAGER_URL;
  resetVmCacheForTests();
});

async function ownedProject(name = "Calculator", previewLabel = "ma-aaaa1111") {
  const owner = await seedUser();
  await seedPreviewHosts([previewLabel]);
  const project = await seedProject({ ownerId: owner.id, previewLabel, name });
  return { owner, project };
}

describe("POST /api/projects/:id/messages", () => {
  test("queues the message and its run, then kicks after the response", async () => {
    const { owner, project } = await ownedProject();
    setCurrentUser(owner);

    const response = await createMessage(
      jsonRequest("http://localhost/api/projects/x/messages", { content: "Add history", mode: "build" }),
      { params: Promise.resolve({ id: project.id }) },
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(WebCreateMessageResponseSchema.safeParse(body).success).toBe(true);
    expect(body.message).toMatchObject({ seq: 1, role: "user", mode: "build", content: "Add history" });
    expect(body.run).toMatchObject({ status: "queued", mode: "build", userMessageId: body.message.id });
    expect(body.message.runId).toBe(body.run.id);

    const [stored] = await testDb().select().from(schema.messages).where(eq(schema.messages.projectId, project.id));
    expect(stored).toMatchObject({ content: "Add history", seq: 1 });

    expect(fakeManager().kick).not.toHaveBeenCalled();
    await runScheduledTasks();
    expect(fakeManager().kick).toHaveBeenCalledWith(project.id, "ma-aaaa1111", MANAGER_TIMEOUTS.kick);
  });

  test("keeps discussion messages out of the build path", async () => {
    const { owner, project } = await ownedProject();
    setCurrentUser(owner);

    const response = await createMessage(
      jsonRequest("http://localhost/api/projects/x/messages", { content: "What about a chart?", mode: "chat" }),
      { params: Promise.resolve({ id: project.id }) },
    );

    const body = await response.json();
    expect(body.message.mode).toBe("chat");
    expect(body.run.mode).toBe("chat");
    expect(await testDb().select().from(schema.versions)).toHaveLength(0);
  });

  test("queues against a stopped VM: a failed kick never fails the request", async () => {
    const { owner, project } = await ownedProject();
    setCurrentUser(owner);
    fakeManager().kick.mockRejectedValue(new ManagerError("ECONNREFUSED", null));

    const response = await createMessage(
      jsonRequest("http://localhost/api/projects/x/messages", { content: "Still queued", mode: "build" }),
      { params: Promise.resolve({ id: project.id }) },
    );

    expect(response.status).toBe(201);
    await expect(runScheduledTasks()).resolves.toBeUndefined();
    expect(await testDb().select().from(schema.runs)).toHaveLength(1);
    expect((await testDb().select().from(schema.runs))[0].status).toBe("queued");
  });

  test("rejects another owner's project and an invalid body", async () => {
    const { owner, project } = await ownedProject();
    setCurrentUser(await seedUser());

    const forbidden = await createMessage(
      jsonRequest("http://localhost/api/projects/x/messages", { content: "Hello", mode: "build" }),
      { params: Promise.resolve({ id: project.id }) },
    );
    expect(forbidden.status).toBe(404);
    expect(await testDb().select().from(schema.messages)).toHaveLength(0);

    setCurrentUser(owner);
    const invalid = await createMessage(
      jsonRequest("http://localhost/api/projects/x/messages", { content: "Hello", mode: "sideways" }),
      { params: Promise.resolve({ id: project.id }) },
    );
    expect(invalid.status).toBe(400);
    expect(await testDb().select().from(schema.messages)).toHaveLength(0);
  });
});

describe("POST /api/projects/:id/ensure", () => {
  test("forwards the preview label and reports readiness", async () => {
    const { owner, project } = await ownedProject();
    setCurrentUser(owner);

    const response = await ensureProject(new Request("http://localhost/api/projects/x/ensure", { method: "POST" }), {
      params: Promise.resolve({ id: project.id }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ready: true });
    expect(fakeManager().ensure).toHaveBeenCalledWith(project.id, "ma-aaaa1111", MANAGER_TIMEOUTS.ensure);
    expect(fakeManager().kick).not.toHaveBeenCalled();
  });

  test("also kicks once when a run is already queued", async () => {
    const { owner, project } = await ownedProject();
    const message = await seedMessage({ projectId: project.id, seq: 1 });
    await seedRun({ projectId: project.id, userMessageId: message.id, status: "queued" });
    setCurrentUser(owner);

    const response = await ensureProject(new Request("http://localhost/api/projects/x/ensure", { method: "POST" }), {
      params: Promise.resolve({ id: project.id }),
    });

    expect(response.status).toBe(200);
    expect(fakeManager().kick).toHaveBeenCalledWith(project.id, "ma-aaaa1111", MANAGER_TIMEOUTS.kick);
  });

  test("reports an unavailable manager and hides other owners' projects", async () => {
    const { owner, project } = await ownedProject();
    setCurrentUser(owner);
    fakeManager().ensure.mockRejectedValue(new ManagerError("timeout", null));

    const unavailable = await ensureProject(
      new Request("http://localhost/api/projects/x/ensure", { method: "POST" }),
      { params: Promise.resolve({ id: project.id }) },
    );
    expect(unavailable.status).toBe(502);

    setCurrentUser(await seedUser());
    const hidden = await ensureProject(new Request("http://localhost/api/projects/x/ensure", { method: "POST" }), {
      params: Promise.resolve({ id: project.id }),
    });
    expect(hidden.status).toBe(404);
  });
});

describe("POST /api/projects/:id/runs/:runId/stop", () => {
  async function runningRun() {
    const { owner, project } = await ownedProject();
    const message = await seedMessage({ projectId: project.id, seq: 1 });
    const run = await seedRun({ projectId: project.id, userMessageId: message.id, status: "running" });
    return { owner, project, run };
  }

  test("forwards the abort to the manager", async () => {
    const { owner, project, run } = await runningRun();
    setCurrentUser(owner);

    const response = await stopRun(new Request("http://localhost/api/projects/x/stop", { method: "POST" }), {
      params: Promise.resolve({ id: project.id, runId: run.id }),
    });

    expect(response.status).toBe(200);
    expect(WebStopRunResponseSchema.safeParse(await response.json()).success).toBe(true);
    expect(fakeManager().abort).toHaveBeenCalledWith(project.id, run.id, MANAGER_TIMEOUTS.abort);
  });

  test("refuses to stop a run that belongs to another project", async () => {
    const { owner, project } = await runningRun();
    await seedPreviewHosts(["ma-bbbb2222"]);
    const otherProject = await seedProject({ ownerId: owner.id, previewLabel: "ma-bbbb2222" });
    const otherMessage = await seedMessage({ projectId: otherProject.id, seq: 1 });
    const otherRun = await seedRun({ projectId: otherProject.id, userMessageId: otherMessage.id, status: "running" });
    setCurrentUser(owner);

    const response = await stopRun(new Request("http://localhost/api/projects/x/stop", { method: "POST" }), {
      params: Promise.resolve({ id: project.id, runId: otherRun.id }),
    });

    expect(response.status).toBe(404);
    expect(fakeManager().abort).not.toHaveBeenCalled();
  });

  test("reports an unavailable manager", async () => {
    const { owner, project, run } = await runningRun();
    setCurrentUser(owner);
    fakeManager().abort.mockRejectedValue(new ManagerError("timeout", null));

    const response = await stopRun(new Request("http://localhost/api/projects/x/stop", { method: "POST" }), {
      params: Promise.resolve({ id: project.id, runId: run.id }),
    });

    expect(response.status).toBe(502);
  });
});

describe("POST /api/projects/:id/versions/:versionId/restore", () => {
  test("returns the new version produced by the manager", async () => {
    const { owner, project } = await ownedProject();
    const version = await seedVersion({ projectId: project.id, number: 1, screenshot: true });
    const restored = {
      id: VERSION_ID,
      projectId: project.id,
      number: 2,
      commitSha: "e".repeat(40),
      summary: "恢复到版本 1",
      runId: null,
      screenshot: true,
      createdAt: "2026-10-08T12:00:00.000Z",
    };
    fakeManager().restore.mockResolvedValue(restored);
    setCurrentUser(owner);

    const response = await restoreVersion(
      new Request("http://localhost/api/projects/x/restore", { method: "POST" }),
      { params: Promise.resolve({ id: project.id, versionId: version.id }) },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(WebRestoreVersionResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toEqual(restored);
    expect(fakeManager().restore).toHaveBeenCalledWith(project.id, version.id, MANAGER_TIMEOUTS.restore);
  });

  test("keeps a conflict from the manager as 409", async () => {
    const { owner, project } = await ownedProject();
    const version = await seedVersion({ projectId: project.id, number: 1 });
    setCurrentUser(owner);
    fakeManager().restore.mockRejectedValue(new ManagerError("run in progress", 409));

    const response = await restoreVersion(
      new Request("http://localhost/api/projects/x/restore", { method: "POST" }),
      { params: Promise.resolve({ id: project.id, versionId: version.id }) },
    );

    expect(response.status).toBe(409);
  });

  test("hides versions of another project behind a 404", async () => {
    const { owner, project } = await ownedProject();
    const foreignVersion = VERSION_ID;
    setCurrentUser(owner);

    const response = await restoreVersion(
      new Request("http://localhost/api/projects/x/restore", { method: "POST" }),
      { params: Promise.resolve({ id: project.id, versionId: foreignVersion }) },
    );

    expect(response.status).toBe(404);
    expect(fakeManager().restore).not.toHaveBeenCalled();
  });
});

describe("GET /api/projects/:id/shots/:sha", () => {
  test("streams the manager's screenshot to the owner", async () => {
    const { owner, project } = await ownedProject();
    const version = await seedVersion({ projectId: project.id, number: 1, screenshot: true });
    setCurrentUser(owner);

    const response = await getScreenshot(new Request("http://localhost/api/projects/x/shots/y"), {
      params: Promise.resolve({ id: project.id, sha: version.commitSha }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
    expect(fakeManager().screenshot).toHaveBeenCalledWith(project.id, version.commitSha, MANAGER_TIMEOUTS.screenshot);
  });

  test("accepts a .png suffix and hides other owners and missing shots", async () => {
    const { owner, project } = await ownedProject();
    const version = await seedVersion({ projectId: project.id, number: 1, screenshot: true });
    setCurrentUser(owner);

    const withSuffix = await getScreenshot(new Request("http://localhost/api/projects/x/shots/y.png"), {
      params: Promise.resolve({ id: project.id, sha: `${version.commitSha}.png` }),
    });
    expect(withSuffix.status).toBe(200);
    expect(fakeManager().screenshot).toHaveBeenLastCalledWith(
      project.id,
      version.commitSha,
      MANAGER_TIMEOUTS.screenshot,
    );

    fakeManager().screenshot.mockResolvedValue(new Response("missing", { status: 404 }));
    const missing = await getScreenshot(new Request("http://localhost/api/projects/x/shots/y"), {
      params: Promise.resolve({ id: project.id, sha: version.commitSha }),
    });
    expect(missing.status).toBe(404);

    setCurrentUser(await seedUser());
    const hidden = await getScreenshot(new Request("http://localhost/api/projects/x/shots/y"), {
      params: Promise.resolve({ id: project.id, sha: version.commitSha }),
    });
    expect(hidden.status).toBe(404);
  });

  test("forbids caching so a cache cannot reuse one account's bytes for another", async () => {
    const { owner, project } = await ownedProject();
    const version = await seedVersion({ projectId: project.id, number: 1, screenshot: true });
    setCurrentUser(owner);

    const response = await getScreenshot(new Request("http://localhost/api/projects/x/shots/y"), {
      params: Promise.resolve({ id: project.id, sha: version.commitSha }),
    });

    const cacheControl = response.headers.get("cache-control") ?? "";
    expect(cacheControl).toContain("no-store");
    expect(cacheControl).not.toContain("max-age");
  });
});

describe("GET /api/projects/:id/stream-token", () => {
  test("signs a short-lived token with the manager secret", async () => {
    const { owner, project } = await ownedProject();
    setCurrentUser(owner);

    const response = await getStreamToken(new Request("http://localhost/api/projects/x/stream-token"), {
      params: Promise.resolve({ id: project.id }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(WebStreamTokenResponseSchema.safeParse(body).success).toBe(true);
    await expect(verifySseToken(body.token, project.id, SHARED_SECRET)).resolves.toBe(true);
    await expect(verifySseToken(body.token, project.id, "another-secret")).resolves.toBe(false);
    expect(body.previewUrl).toBe("https://ma-aaaa1111.expii.top");
    expect(body.streamUrl).toBe(
      `https://manager.test/projects/${project.id}/stream?token=${encodeURIComponent(body.token)}`,
    );
  });

  test("refuses another owner and an unconfigured environment", async () => {
    const { project } = await ownedProject();
    setCurrentUser(await seedUser());

    const hidden = await getStreamToken(new Request("http://localhost/api/projects/x/stream-token"), {
      params: Promise.resolve({ id: project.id }),
    });
    expect(hidden.status).toBe(404);

    const { owner: secondOwner, project: secondProject } = await ownedProject("Second", "ma-bbbb2222");
    setCurrentUser(secondOwner);
    delete process.env.MA_SHARED_SECRET;
    const unconfigured = await getStreamToken(new Request("http://localhost/api/projects/x/stream-token"), {
      params: Promise.resolve({ id: secondProject.id }),
    });
    expect(unconfigured.status).toBe(502);
  });
});

describe("GET /api/vm", () => {
  test("reports the manager health and caches it for 10 seconds", async () => {
    setCurrentUser(await seedUser());
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T12:00:00.000Z"));

    const first = await getVm();
    const body = await first.json();
    expect(WebVmResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toEqual({ up: true });

    await getVm();
    expect(fakeManager().health).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(Date.now() + VM_STATUS_CACHE_MS + 1));
    await getVm();
    expect(fakeManager().health).toHaveBeenCalledTimes(2);
  });

  test("reports the VM as down when the manager is unreachable and requires a session", async () => {
    setCurrentUser(await seedUser());
    fakeManager().health.mockResolvedValue(false);

    const response = await getVm();
    await expect(response.json()).resolves.toEqual({ up: false });

    setCurrentUser(null);
    resetVmCacheForTests();
    expect((await getVm()).status).toBe(401);
  });
});
