import { describe, expect, test } from "bun:test";
import {
  AnnotationSchema,
  AgentRefSchema,
  AgentRoleSchema,
  PlanPhaseSchema,
  PlanTaskSchema,
  ProjectDetailSchema,
  ProjectSummarySchema,
  RunEventSchema,
  VersionDTOSchema,
  formatUserPrompt,
  verifySseToken,
  signSseToken,
  SSE_TOKEN_TTL_SECONDS,
} from "./index";
import sampleEvents from "../../../fixtures/events/sample-run.json";

const projectId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const versionId = "33333333-3333-4333-8333-333333333333";

describe("shared protocol schemas", () => {
  test("accepts project, version, and event DTOs at the public export", () => {
    expect(ProjectSummarySchema.parse({
      id: projectId,
      name: "Recipe box",
      updatedAt: "2026-10-08T12:00:00.000Z",
      hasRunningRun: false,
      latestVersionNumber: 2,
      currentScreenshotSha: "0123456789abcdef0123456789abcdef01234567",
    }).name).toBe("Recipe box");
    expect(ProjectSummarySchema.safeParse({
      id: projectId,
      name: "Recipe box",
      updatedAt: "2026-10-08T12:00:00.000Z",
      hasRunningRun: false,
      latestVersionNumber: null,
      currentScreenshotSha: null,
    }).success).toBe(true);
    expect(VersionDTOSchema.safeParse({
      id: versionId,
      projectId,
      number: 2,
      commitSha: "0123456789abcdef",
      summary: "Add recipe list",
      runId,
      screenshot: false,
      createdAt: "2026-10-08T12:00:00.000Z",
    }).success).toBe(true);
    expect(RunEventSchema.safeParse(sampleEvents[0]).success).toBe(true);
  });

  test("rejects malformed fields and preserves complete project detail shape", () => {
    expect(ProjectSummarySchema.safeParse({ id: "not-a-uuid", name: "x" }).success).toBe(false);
    expect(ProjectSummarySchema.safeParse({
      id: projectId,
      name: "Recipe box",
      updatedAt: "2026-10-08T12:00:00.000Z",
      hasRunningRun: false,
      latestVersionNumber: null,
    }).success).toBe(false);
    expect(RunEventSchema.safeParse({ ...sampleEvents[0], seq: 0 }).success).toBe(false);
    expect(ProjectDetailSchema.safeParse({
      id: projectId,
      name: "Recipe box",
      previewLabel: "ma-abc12345",
      accountSuspended: false,
      currentVersionId: versionId,
      createdAt: "2026-10-08T12:00:00.000Z",
      updatedAt: "2026-10-08T12:00:00.000Z",
      messages: [],
      runs: [],
      versions: [],
      lastEventId: 0,
    }).success).toBe(true);
  });

  test("fixture parses and covers all visible run status and event kinds", () => {
    const events = RunEventSchema.array().parse(sampleEvents);
    expect(new Set(events.filter((event) => event.kind === "status").map((event) => event.status))).toEqual(new Set([
      "queued", "starting", "running", "verifying", "repairing", "committing", "succeeded", "failed", "cancelled",
    ]));
    expect(new Set(events.map((event) => event.kind))).toEqual(new Set(["status", "thinking", "text", "tool", "version", "error"]));
  });

  test("fixture includes failed tool and environment-restart retry branches", () => {
    const events = RunEventSchema.array().parse(sampleEvents);
    const failedToolEnd = events.find((event) => event.kind === "tool" && event.phase === "end" && event.ok === false);
    expect(failedToolEnd).toMatchObject({ kind: "tool", phase: "end", ok: false, summary: "Type check failed." });

    for (const event of events) {
      if (event.kind === "tool" && event.phase === "end") {
        expect(events.some((start) =>
          start.kind === "tool" &&
          start.phase === "start" &&
          start.runId === event.runId &&
          start.toolCallId === event.toolCallId &&
          start.seq < event.seq,
        )).toBe(true);
      }
    }

    const restartRunId = "77777777-7777-4777-8777-777777777777";
    const restartEvents = events.filter((event) => event.runId === restartRunId);
    expect(restartEvents.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(restartEvents).toContainEqual(expect.objectContaining({ kind: "error", message: "环境重启" }));
    expect(restartEvents).toContainEqual(expect.objectContaining({ kind: "status", status: "failed", detail: "环境重启" }));
  });

  test("keeps stored tool events valid and accepts the new plan, agent, and steer events", () => {
    const base = { runId, seq: 1, at: "2026-10-08T12:00:00.000Z" };
    const legacyTool = {
      ...base, kind: "tool", phase: "start", toolCallId: "call-1", name: "read", title: "Read file",
    };
    expect(RunEventSchema.safeParse(legacyTool).success).toBe(true);
    expect(RunEventSchema.safeParse({ ...legacyTool, agent: { id: "pm", role: "pm" } }).success).toBe(true);

    expect(RunEventSchema.safeParse({
      ...base,
      kind: "plan",
      phases: [{ name: "实现", tasks: [{ content: "共享协议", status: "in_progress" }] }],
    }).success).toBe(true);
    expect(RunEventSchema.safeParse({
      ...base,
      kind: "agent",
      phase: "end",
      agent: { id: "designer-1", role: "designer" },
      label: "整理页面布局",
      ok: true,
      summary: "完成界面调整",
    }).success).toBe(true);
    expect(RunEventSchema.safeParse({ ...base, kind: "steer", messageId: versionId }).success).toBe(true);

    expect(AgentRoleSchema.safeParse("reviewer").success).toBe(false);
    expect(AgentRefSchema.safeParse({ id: "agent-1", role: "reviewer" }).success).toBe(false);
    expect(PlanTaskSchema.safeParse({ content: "x", status: "started" }).success).toBe(false);
    expect(PlanPhaseSchema.safeParse({ name: "x", tasks: [{ content: "x", status: "started" }] }).success).toBe(false);
    expect(RunEventSchema.safeParse({
      ...base, kind: "agent", phase: "launch", agent: { id: "agent-1", role: "pm" }, label: "x",
    }).success).toBe(false);
    expect(RunEventSchema.safeParse({
      ...base,
      kind: "agent",
      phase: "start",
      agent: { id: "agent-1", role: "pm" },
      label: "x".repeat(61),
    }).success).toBe(false);
    expect(RunEventSchema.safeParse({
      ...base,
      kind: "agent",
      phase: "end",
      agent: { id: "agent-1", role: "pm" },
      label: "x",
      summary: "x".repeat(201),
    }).success).toBe(false);
    expect(RunEventSchema.safeParse({ ...base, kind: "steer", messageId: "bad-id" }).success).toBe(false);
  });

  test("enforces annotation field length limits", () => {
    const annotation = {
      route: "/settings",
      tag: "button",
      text: "保存",
      selector: "main > button",
      component: "SettingsForm",
      source: "src/settings.tsx:12",
      rect: { x: 1, y: 2, w: 3, h: 4 },
    };
    expect(AnnotationSchema.safeParse(annotation).success).toBe(true);
    for (const [field, limit] of Object.entries({ route: 200, tag: 40, text: 200, selector: 300, component: 80, source: 200 })) {
      expect(AnnotationSchema.safeParse({ ...annotation, [field]: "x".repeat(limit + 1) }).success).toBe(false);
    }
  });

  test("formats full, partial, and absent annotations for the user prompt", () => {
    const full = {
      route: "/settings",
      tag: "button",
      text: "保存",
      selector: "main > form > button:nth-of-type(2)",
      component: "SettingsForm",
      source: "src/components/settings-form.tsx:84",
      rect: { x: 10, y: 20, w: 80, h: 32 },
    };
    expect(formatUserPrompt("保存配置", full)).toBe([
      "保存配置",
      "",
      "[用户在预览中标注的元素]",
      "页面：/settings",
      '元素：<button> "保存"',
      "位置：src/components/settings-form.tsx:84（组件 SettingsForm）",
      "选择器：main > form > button:nth-of-type(2)",
    ].join("\n"));
    expect(formatUserPrompt("修复此处", {
      route: "/home", tag: "div", text: "", selector: "#main", rect: { x: 0, y: 0, w: 1, h: 1 },
    })).toBe([
      "修复此处",
      "",
      "[用户在预览中标注的元素]",
      "页面：/home",
      '元素：<div> ""',
      "选择器：#main",
    ].join("\n"));
    expect(formatUserPrompt("原样保留")).toBe("原样保留");
  });
});

describe("SSE token", () => {
  const secret = "test-only-secret";
  const now = Date.UTC(2026, 9, 8, 12, 0, 0);

  test("uses the documented payload and 10-minute HMAC contract", async () => {
    const token = await signSseToken(projectId, secret, now);
    const [encodedPayload, encodedSignature] = token.split(".");
    const decoded = atob(encodedPayload.replace(/-/g, "+").replace(/_/g, "/") + "==");
    expect(JSON.parse(decoded)).toEqual({ p: projectId, exp: now / 1000 + SSE_TOKEN_TTL_SECONDS });
    expect(encodedSignature).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await verifySseToken(token, projectId, secret, now)).toBe(true);
  });

  test("rejects tampering, project mismatch, and expiry", async () => {
    const token = await signSseToken(projectId, secret, now);
    const [payload, signature] = token.split(".");
    const tampered = `${payload}.${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;
    expect(await verifySseToken(tampered, projectId, secret, now)).toBe(false);
    expect(await verifySseToken(token, "44444444-4444-4444-8444-444444444444", secret, now)).toBe(false);
    expect(await verifySseToken(token, projectId, secret, now + (SSE_TOKEN_TTL_SECONDS + 1) * 1000)).toBe(false);
  });
});
