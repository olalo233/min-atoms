import { z } from "zod";

const idSchema = z.uuid();
const nullableDateTime = z.iso.datetime().nullable();

// Database-backed values are serialized as ISO 8601 strings at the API edge.
export const RunStatusSchema = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
export const RunModeSchema = z.enum(["chat", "build"]);
export const MessageRoleSchema = z.enum(["user", "assistant"]);

export const VersionDTOSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  number: z.number().int().positive(),
  commitSha: z.string().min(1),
  summary: z.string(),
  runId: idSchema.nullable(),
  screenshot: z.boolean(),
  createdAt: z.iso.datetime(),
});

export const RunEventSchema = z.discriminatedUnion("kind", [
  z.object({
    runId: idSchema,
    seq: z.number().int().positive(),
    at: z.iso.datetime(),
    kind: z.literal("status"),
    status: z.enum(["queued", "starting", "running", "verifying", "repairing", "committing", "succeeded", "failed", "cancelled"]),
    detail: z.string().optional(),
  }),
  z.object({ runId: idSchema, seq: z.number().int().positive(), at: z.iso.datetime(), kind: z.literal("text"), delta: z.string() }),
  z.object({ runId: idSchema, seq: z.number().int().positive(), at: z.iso.datetime(), kind: z.literal("thinking"), delta: z.string() }),
  z.object({
    runId: idSchema,
    seq: z.number().int().positive(),
    at: z.iso.datetime(),
    kind: z.literal("tool"),
    phase: z.enum(["start", "end"]),
    toolCallId: z.string().min(1),
    name: z.string().min(1),
    title: z.string().min(1),
    ok: z.boolean().optional(),
    summary: z.string().optional(),
  }),
  z.object({
    runId: idSchema,
    seq: z.number().int().positive(),
    at: z.iso.datetime(),
    kind: z.literal("version"),
    versionId: idSchema,
    number: z.number().int().positive(),
    commitSha: z.string().min(1),
    summary: z.string(),
  }),
  z.object({ runId: idSchema, seq: z.number().int().positive(), at: z.iso.datetime(), kind: z.literal("error"), message: z.string().min(1) }),
]);

export const MessageDTOSchema = z.object({
  id: idSchema,
  seq: z.number().int().positive(),
  role: MessageRoleSchema,
  mode: RunModeSchema,
  content: z.string(),
  runId: idSchema.nullable(),
  versionId: idSchema.nullable(),
  createdAt: z.iso.datetime(),
});

export const RunDTOSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  userMessageId: idSchema,
  mode: RunModeSchema,
  status: RunStatusSchema,
  error: z.string().nullable(),
  createdAt: z.iso.datetime(),
  startedAt: nullableDateTime,
  finishedAt: nullableDateTime,
  events: z.array(RunEventSchema).optional(),
});

export const ProjectSummarySchema = z.object({
  id: idSchema,
  name: z.string(),
  updatedAt: z.iso.datetime(),
  hasRunningRun: z.boolean(),
  latestVersionNumber: z.number().int().positive().nullable(),
  currentScreenshotSha: z.string().min(1).nullable(),
});

export const ProjectDetailSchema = z.object({
  id: idSchema,
  name: z.string(),
  previewLabel: z.string().min(1),
  currentVersionId: idSchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  messages: z.array(MessageDTOSchema),
  runs: z.array(RunDTOSchema),
  versions: z.array(VersionDTOSchema),
  lastEventId: z.number().int().nonnegative(),
});

// Manager API request and response bodies documented in architecture.md §10.
export const ManagerHealthResponseSchema = z.object({
  ok: z.boolean(), version: z.string(), containers: z.number().int().nonnegative(),
  idleSeconds: z.number().int().nonnegative().optional(),
});
export const ManagerEnsureRequestSchema = z.object({ previewLabel: z.string().min(1) });
export const ManagerEnsureResponseSchema = z.object({ ready: z.literal(true) });
export const ManagerKickRequestSchema = z.object({ previewLabel: z.string().min(1) });
export const ManagerKickResponseSchema = z.object({});
export const ManagerAbortRequestSchema = z.object({});
export const ManagerAbortResponseSchema = z.object({});
export const ManagerRestoreRequestSchema = z.object({ versionId: idSchema });
export const ManagerRestoreResponseSchema = VersionDTOSchema;
export const ManagerDeleteResponseSchema = z.object({});
export const ManagerStreamEventSchema = z.object({ id: z.number().int().positive(), event: RunEventSchema });

export const WebCreateProjectRequestSchema = z.object({ prompt: z.string().min(1) });
export const WebCreateProjectResponseSchema = z.object({ id: idSchema });
export const WebProjectListResponseSchema = z.array(ProjectSummarySchema);
export const WebProjectDetailResponseSchema = ProjectDetailSchema;
export const WebCreateMessageRequestSchema = z.object({ content: z.string().min(1), mode: RunModeSchema });
export const WebCreateMessageResponseSchema = z.object({ message: MessageDTOSchema, run: RunDTOSchema });
export const WebStopRunResponseSchema = z.object({});
export const WebRestoreVersionResponseSchema = VersionDTOSchema;
export const WebDeleteProjectResponseSchema = z.object({});
export const WebStreamTokenResponseSchema = z.object({ token: z.string().min(1), streamUrl: z.string().url(), previewUrl: z.string().url() });
export const WebVmResponseSchema = z.object({ up: z.boolean() });

export type RunEvent = z.infer<typeof RunEventSchema>;
export type VersionDTO = z.infer<typeof VersionDTOSchema>;
export type MessageDTO = z.infer<typeof MessageDTOSchema>;
export type RunDTO = z.infer<typeof RunDTOSchema>;
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;
export type ProjectDetail = z.infer<typeof ProjectDetailSchema>;

export const SSE_TOKEN_TTL_SECONDS = 10 * 60;
const encoder = new TextEncoder();

function assertProjectId(projectId: string): void {
  if (!idSchema.safeParse(projectId).success) throw new TypeError("projectId must be a UUID");
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError("Invalid base64url value");
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new TypeError("secret must not be empty");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signSseToken(projectId: string, secret: string, now = Date.now()): Promise<string> {
  assertProjectId(projectId);
  if (!Number.isFinite(now) || now < 0) throw new TypeError("now must be a non-negative timestamp");
  const exp = Math.floor(now / 1000) + SSE_TOKEN_TTL_SECONDS;
  const payload = encodeBase64Url(encoder.encode(JSON.stringify({ p: projectId, exp })));
  const signature = await crypto.subtle.sign("HMAC", await importHmacKey(secret), encoder.encode(payload));
  return `${payload}.${encodeBase64Url(new Uint8Array(signature))}`;
}

export async function verifySseToken(token: string, projectId: string, secret: string, now = Date.now()): Promise<boolean> {
  try {
    assertProjectId(projectId);
    if (!Number.isFinite(now) || now < 0 || !secret) return false;
    const parts = token.split(".");
    if (parts.length !== 2) return false;
    const [payloadPart, signaturePart] = parts;
    const payloadBytes = decodeBase64Url(payloadPart);
    const signature = decodeBase64Url(signaturePart);
    if (signature.byteLength !== 32) return false;
    const payload: unknown = JSON.parse(new TextDecoder().decode(payloadBytes));
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
    const fields = payload as Record<string, unknown>;
    if (Object.keys(fields).length !== 2 || typeof fields.p !== "string" || !Number.isSafeInteger(fields.exp)) return false;
    if (fields.p !== projectId || !idSchema.safeParse(fields.p).success) return false;
    const nowSeconds = Math.floor(now / 1000);
    if ((fields.exp as number) <= nowSeconds || (fields.exp as number) > nowSeconds + SSE_TOKEN_TTL_SECONDS) return false;
    // Copy into a fresh view: with lib.dom in the program, BufferSource requires
    // an ArrayBuffer-backed view, which is all this ever was.
    const signatureBytes = new Uint8Array(signature.length);
    signatureBytes.set(signature);
    return await crypto.subtle.verify("HMAC", await importHmacKey(secret), signatureBytes, encoder.encode(payloadPart));
  } catch {
    return false;
  }
}
