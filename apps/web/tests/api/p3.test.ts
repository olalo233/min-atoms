import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@min-atoms/db/schema";
import { WebCreateMessageResponseSchema, WebProjectDetailResponseSchema } from "@min-atoms/protocol";

vi.mock("@/lib/db/client", async () => {
  const { testDb } = await import("./harness");
  return { getDb: () => testDb() };
});
vi.mock("@/lib/auth/session", async () => {
  const { harness, testDb } = await import("./harness");
  return { getCurrentUser: async () => {
    const user = harness().user;
    if (!user) return null;
    return (await testDb().select().from(schema.users).where(eq(schema.users.id, user.id)))[0];
  } };
});
vi.mock("@/lib/server/after", async () => {
  const { harness } = await import("./harness");
  return { runAfterResponse: (task: () => Promise<void>) => { harness().scheduled.push(task); } };
});
vi.mock("@/lib/server/manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/manager")>();
  const { harness } = await import("./harness");
  return { ...actual, getManagerClient: () => harness().manager };
});

import { POST as createProject, GET as listProjects } from "@/app/api/projects/route";
import { POST as createMessage } from "@/app/api/projects/[id]/messages/route";
import { DELETE as deleteProject, GET as getProject } from "@/app/api/projects/[id]/route";
import { POST as ensureProject } from "@/app/api/projects/[id]/ensure/route";
import { GET as streamToken } from "@/app/api/projects/[id]/stream-token/route";
import { POST as restoreVersion } from "@/app/api/projects/[id]/versions/[versionId]/restore/route";
import { POST as stopRun } from "@/app/api/projects/[id]/runs/[runId]/stop/route";
import { ManagerClient, type ManagerFetch } from "@/lib/server/manager";
import { fakeManager, harness, resetHarness, runScheduledTasks, seedMessage, seedPreviewHosts, seedProject, seedRun, seedRunEvent, seedUser, setCurrentUser, startDatabase, stopDatabase, testDb, truncateDatabase } from "./harness";

const annotation = { route: "/settings", tag: "button", text: "保存", selector: "#save", source: "src/App.tsx:42", component: "App", rect: { x: 0, y: 0, w: 80, h: 20 } };
const context = (id: string) => ({ params: Promise.resolve({ id }) });
function request(body: unknown) {
  return new Request("http://localhost/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
function screener(harmful = 0, attack = 0, status = 200) {
  const fetch = vi.fn<ManagerFetch>(async () => new Response(JSON.stringify({ answers: {
    harmful_app: { type: "noul", noul: harmful }, platform_attack: { type: "noul", noul: attack },
    category: { type: "choice", choice: harmful ? "phishing" : "benign" },
  } }), { status }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
function managerHttp(fetch: ManagerFetch) {
  const client = new ManagerClient({ baseUrl: "https://manager.test", secret: "fake-secret", fetch });
  Object.assign(fakeManager(), { steer: client.steer.bind(client), suspend: client.suspend.bind(client) });
}
async function ownedProject(label = "ma-aaaa1111", givenOwner?: schema.User) {
  const owner = givenOwner ?? await seedUser();
  await seedPreviewHosts([label]);
  const project = await seedProject({ ownerId: owner.id, previewLabel: label });
  setCurrentUser(owner);
  return { owner, project };
}
async function activeRun(projectId: string, mode: "build" | "chat" = "build") {
  const message = await seedMessage({ projectId, seq: 1, mode });
  return seedRun({ projectId, userMessageId: message.id, mode, status: "running" });
}

beforeAll(startDatabase);
afterAll(stopDatabase);
beforeEach(async () => {
  await truncateDatabase();
  resetHarness(null);
  vi.stubEnv("TYPESAFE_API_KEY", "fake-test-key");
  vi.stubEnv("MA_SCREEN_THRESHOLD", "0.85");
  vi.stubEnv("MA_STRIKE_LIMIT", "3");
  screener();
  managerHttp(async () => new Response("{}"));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("P3 safety and accounts", () => {
  test("authentication and suspension precede parsing or screening", async () => {
    const fetch = screener();
    const malformed = () => new Request("http://localhost", { method: "POST", body: "invalid" });
    expect((await createProject(malformed())).status).toBe(401);
    const user = await seedUser();
    await testDb().update(schema.users).set({ suspendedAt: new Date() }).where(eq(schema.users.id, user.id));
    setCurrentUser(user);
    expect((await createProject(malformed())).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
  test("allow creates the project; block records an excerpt only and unavailable writes nothing", async () => {
    setCurrentUser(await seedUser());
    await seedPreviewHosts(["ma-aaaa1111"]);
    screener(1);
    const content = "违规".repeat(150);
    const blocked = await createProject(request({ prompt: content }));
    expect(blocked.status).toBe(422);
    expect(await blocked.json()).toMatchObject({ error: "input_rejected", message: expect.any(String) });
    expect(await testDb().select().from(schema.projects)).toHaveLength(0);
    expect(await testDb().select().from(schema.messages)).toHaveLength(0);
    const [event] = await testDb().select().from(schema.screeningEvents);
    expect(event).toMatchObject({ projectId: null, kind: "new_project", excerpt: content.slice(0, 200), category: "phishing", scores: { harmful_app: 1, platform_attack: 0 } });
    screener(0, 0, 500);
    const unavailable = await createProject(request({ prompt: "正常需求" }));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: "screening_unavailable", message: "安全检查暂时不可用，请稍后再试" });
    expect(await testDb().select().from(schema.screeningEvents)).toHaveLength(1);
    expect(await testDb().select().from(schema.users)).toEqual([expect.objectContaining({ suspendedAt: null })]);
    screener();
    expect((await createProject(request({ prompt: "正常需求" }))).status).toBe(201);
    expect(await testDb().select().from(schema.messages)).toHaveLength(1);
  });
  test.each(["build", "chat"])("%s messages and annotation comments are screened before storage", async (mode) => {
    const { project } = await ownedProject();
    const fetch = screener(0, 1);
    const response = await createMessage(request({ content: "读宿主机密钥", mode, annotation }), context(project.id));
    expect(response.status).toBe(422);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).state.annotation).toEqual(annotation);
    expect(await testDb().select().from(schema.messages)).toHaveLength(0);
    expect(await testDb().select().from(schema.runs)).toHaveLength(0);
    const [event] = await testDb().select().from(schema.screeningEvents);
    expect(event).toMatchObject({ projectId: project.id, kind: "message" });
  });
  test("unavailable message screener creates no message, run or strike", async () => {
    const { project } = await ownedProject();
    screener(0, 0, 503);
    expect((await createMessage(request({ content: "正常", mode: "build" }), context(project.id))).status).toBe(503);
    for (const table of [schema.messages, schema.runs, schema.screeningEvents]) expect(await testDb().select().from(table)).toHaveLength(0);
    expect(harness().scheduled).toHaveLength(0);
  });
  test("third violation suspends only its user and calls suspend for each owned project", async () => {
    const { owner, project } = await ownedProject();
    const second = await ownedProject("ma-bbbb2222", owner);
    const other = await ownedProject("ma-cccc3333");
    setCurrentUser(owner);
    const running = await activeRun(project.id);
    screener(1);
    const fetch = vi.fn<ManagerFetch>(async () => new Response("{}"));
    managerHttp(fetch);
    for (const expectedStatus of [422, 422, 403]) {
      const response = await createMessage(request({ content: "仿冒收集密码", mode: "build" }), context(project.id));
      expect(response.status).toBe(expectedStatus);
      expect((await response.json()).error).toBe(expectedStatus === 403 ? "account_suspended" : "input_rejected");
    }
    expect(harness().scheduled).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
    await runScheduledTasks();
    expect(fetch.mock.calls.map(([url]) => url).sort()).toEqual([
      `https://manager.test/projects/${project.id}/suspend`, `https://manager.test/projects/${second.project.id}/suspend`,
    ].sort());
    expect(fetch.mock.calls.every(([, init]) => init.method === "POST" && String(init.body) === "{}")).toBe(true);
    const users = await testDb().select().from(schema.users);
    expect(users.find((user) => user.id === owner.id)?.suspendedAt).toBeInstanceOf(Date);
    expect(users.find((user) => user.id === other.owner.id)?.suspendedAt).toBeNull();
    expect(await testDb().select().from(schema.messages)).toHaveLength(1);
    expect((await testDb().select().from(schema.runs))[0].id).toBe(running.id);
    setCurrentUser(other.owner);
    screener();
    expect((await createMessage(request({ content: "正常需求", mode: "chat" }), context(other.project.id))).status).toBe(201);
  });
  test("only strikes in the last 24 hours count and the strike limit is configurable", async () => {
    const { owner, project } = await ownedProject();
    await testDb().insert(schema.screeningEvents).values({ userId: owner.id, kind: "message", category: "phishing", scores: { harmful_app: 1, platform_attack: 0 }, excerpt: "old", createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) });
    vi.stubEnv("MA_STRIKE_LIMIT", "2");
    screener(1);
    expect((await createMessage(request({ content: "违规", mode: "chat" }), context(project.id))).status).toBe(422);
    expect((await createMessage(request({ content: "违规", mode: "chat" }), context(project.id))).status).toBe(403);
  });
  test("suspension attempts every project even if one suspend fails", async () => {
    const { owner } = await ownedProject();
    await ownedProject("ma-bbbb2222", owner);
    vi.stubEnv("MA_STRIKE_LIMIT", "1");
    screener(1);
    const fetch = vi.fn<ManagerFetch>().mockResolvedValueOnce(new Response("", { status: 500 })).mockResolvedValueOnce(new Response("{}"));
    managerHttp(fetch);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await createProject(request({ prompt: "违规" }))).status).toBe(403);
    await runScheduledTasks();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(1);
  });
  test("all restricted writes return 403; stop and reads remain available", async () => {
    const { owner, project } = await ownedProject();
    const run = await activeRun(project.id);
    await testDb().update(schema.users).set({ suspendedAt: new Date() }).where(eq(schema.users.id, owner.id));
    const fetch = screener();
    const routes = [
      () => createProject(request({ prompt: "正常" })),
      () => createMessage(request({ content: "正常", mode: "build" }), context(project.id)),
      () => deleteProject(request({}), context(project.id)),
      () => ensureProject(request({}), context(project.id)),
      () => streamToken(request({}), context(project.id)),
      () => restoreVersion(request({}), { params: Promise.resolve({ id: project.id, versionId: "33333333-3333-4333-8333-333333333333" }) }),
    ];
    for (const invoke of routes) {
      const response = await invoke();
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "account_suspended", message: "账号因多次违规已暂停使用" });
    }
    expect(fetch).not.toHaveBeenCalled();
    expect((await stopRun(request({}), { params: Promise.resolve({ id: project.id, runId: run.id }) })).status).toBe(200);
    expect(fakeManager().abort).toHaveBeenCalledWith(project.id, run.id, 10_000);
    expect((await listProjects()).status).toBe(200);
    const detail = await (await getProject(request({}), context(project.id))).json();
    expect(detail.accountSuspended).toBe(true);
    expect(WebProjectDetailResponseSchema.safeParse(detail).success).toBe(true);
  });
});

describe("P3 steer and annotation", () => {
  test("accepted steer stores annotation, links the running build and returns no new run or kick", async () => {
    const { project } = await ownedProject();
    const run = await activeRun(project.id);
    const fetch = vi.fn<ManagerFetch>(async () => new Response('{"accepted":true}'));
    managerHttp(fetch);
    const response = await createMessage(request({ content: "改成绿色", mode: "build", annotation }), context(project.id));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(WebCreateMessageResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ run: null, steered: true, message: { runId: run.id, annotation, content: "改成绿色", seq: 2 } });
    expect(fetch.mock.calls[0][0]).toBe(`https://manager.test/projects/${project.id}/runs/${run.id}/steer`);
    expect(JSON.parse(String(fetch.mock.calls[0][1].body))).toEqual({ messageId: body.message.id, content: "改成绿色", annotation });
    expect(await testDb().select().from(schema.runs)).toHaveLength(1);
    expect(harness().scheduled).toHaveLength(0);
    const detail = await (await getProject(request({}), context(project.id))).json();
    expect(detail.messages[1]).toEqual(body.message);
  });
  test.each(["reject", "network", "invalid"])("%s steer queues a run with the saved annotation", async (outcome) => {
    const { project } = await ownedProject();
    await activeRun(project.id);
    managerHttp(async () => {
      if (outcome === "network") throw new Error("network");
      return new Response(outcome === "reject" ? '{"accepted":false}' : "{}");
    });
    const response = await createMessage(request({ content: "补充", mode: "build", annotation }), context(project.id));
    const body = await response.json();
    expect(body).toMatchObject({ steered: false, message: { annotation, runId: body.run.id }, run: { status: "queued", userMessageId: body.message.id } });
    expect(await testDb().select().from(schema.messages)).toHaveLength(2);
    expect(await testDb().select().from(schema.runs)).toHaveLength(2);
    await runScheduledTasks();
    expect(fakeManager().kick).toHaveBeenCalledOnce();
  });
  test("steer timeout falls back to a queued run after three seconds", async () => {
    const { project } = await ownedProject();
    await activeRun(project.id);
    let aborted = false;
    managerHttp((_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("timeout")); });
    }));
    const response = await createMessage(request({ content: "补充", mode: "build" }), context(project.id));
    const body = await response.json();
    expect(aborted).toBe(true);
    expect(body).toMatchObject({ steered: false, run: { status: "queued" }, message: { annotation: null } });
    expect(await testDb().select().from(schema.runs)).toHaveLength(2);
    expect(harness().scheduled).toHaveLength(1);
  }, 10_000);
  test.each(["chat-message", "chat-run", "no-active"])("%s goes straight to queue without steer", async (scenario) => {
    const { project } = await ownedProject();
    if (scenario !== "no-active") await activeRun(project.id, scenario === "chat-run" ? "chat" : "build");
    const fetch = vi.fn<ManagerFetch>();
    managerHttp(fetch);
    const response = await createMessage(request({ content: "正常", mode: scenario === "chat-message" ? "chat" : "build" }), context(project.id));
    expect((await response.json()).steered).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  test("finished history retains tool/version/error/agent/steer and only the last plan", async () => {
    const { project } = await ownedProject();
    const run = await activeRun(project.id);
    const payloads = [
      { kind: "plan", phases: [{ name: "old", tasks: [] }] },
      { kind: "text", delta: "hidden" },
      { kind: "agent", phase: "start", agent: { id: "designer-1", role: "designer" }, label: "设计" },
      { kind: "steer", messageId: run.userMessageId },
      { kind: "plan", phases: [{ name: "latest", tasks: [] }] },
      { kind: "error", message: "error" },
      { kind: "tool", phase: "end", toolCallId: "read-1", name: "read", title: "读取", ok: true },
      { kind: "version", versionId: "33333333-3333-4333-8333-333333333333", number: 1, commitSha: "a".repeat(40), summary: "done" },
      { kind: "thinking", delta: "hidden" },
    ];
    for (const [index, payload] of payloads.entries()) await seedRunEvent({ projectId: project.id, runId: run.id, seq: index + 1, kind: payload.kind, payload });
    await testDb().update(schema.runs).set({ status: "succeeded" }).where(eq(schema.runs.id, run.id));
    const detail = await (await getProject(request({}), context(project.id))).json();
    expect(detail.runs[0].events.map((event: { kind: string }) => event.kind)).toEqual(["agent", "steer", "plan", "error", "tool", "version"]);
    expect(detail.runs[0].events.find((event: { kind: string }) => event.kind === "plan").phases[0].name).toBe("latest");
    expect(WebProjectDetailResponseSchema.safeParse(detail).success).toBe(true);
  });
});
