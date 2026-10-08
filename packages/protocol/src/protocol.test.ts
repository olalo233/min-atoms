import { describe, expect, test } from "bun:test";
import {
  ProjectDetailSchema,
  ProjectSummarySchema,
  RunEventSchema,
  VersionDTOSchema,
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
