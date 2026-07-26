import { z } from "zod";

export const GENERATED_APP_DATA_LIMITS = {
  keyLength: 96,
  requestIdLength: 96,
  valueBytes: 16_384,
  valueDepth: 16,
} as const;

export type GeneratedAppDataValue =
  | null
  | boolean
  | number
  | string
  | GeneratedAppDataValue[]
  | { [key: string]: GeneratedAppDataValue };

const identifierSchema = z.string().trim().min(1).max(GENERATED_APP_DATA_LIMITS.requestIdLength);
const keySchema = z
  .string()
  .min(1)
  .max(GENERATED_APP_DATA_LIMITS.keyLength)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

const requestBase = {
  artifactVersionId: identifierSchema,
  projectId: identifierSchema,
  requestId: identifierSchema,
  type: z.literal("min-atoms-data-request"),
};

const previewDataRequestSchema = z.discriminatedUnion("operation", [
  z.object({ ...requestBase, key: keySchema, operation: z.literal("get") }).strict(),
  z.object({ ...requestBase, operation: z.literal("list") }).strict(),
  z
    .object({ ...requestBase, key: keySchema, operation: z.literal("set"), value: z.unknown() })
    .strict(),
  z.object({ ...requestBase, key: keySchema, operation: z.literal("delete") }).strict(),
]);

export type PreviewDataRequest =
  | {
      artifactVersionId: string;
      key: string;
      operation: "get";
      projectId: string;
      requestId: string;
      type: "min-atoms-data-request";
    }
  | {
      artifactVersionId: string;
      operation: "list";
      projectId: string;
      requestId: string;
      type: "min-atoms-data-request";
    }
  | {
      artifactVersionId: string;
      key: string;
      operation: "set";
      projectId: string;
      requestId: string;
      type: "min-atoms-data-request";
      value: GeneratedAppDataValue;
    }
  | {
      artifactVersionId: string;
      key: string;
      operation: "delete";
      projectId: string;
      requestId: string;
      type: "min-atoms-data-request";
    };

export function isGeneratedAppDataValue(
  value: unknown,
  seen = new Set<unknown>(),
  depth = 0,
): value is GeneratedAppDataValue {
  if (depth > GENERATED_APP_DATA_LIMITS.valueDepth) {
    return false;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object" || seen.has(value)) {
    return false;
  }

  seen.add(value);
  const isValid = Array.isArray(value)
    ? value.every((item) => isGeneratedAppDataValue(item, seen, depth + 1))
    : Object.getPrototypeOf(value) === Object.prototype &&
      Object.values(value).every((item) =>
        isGeneratedAppDataValue(item, seen, depth + 1),
      );
  seen.delete(value);
  return isValid;
}

function fitsValueLimit(value: GeneratedAppDataValue): boolean {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= GENERATED_APP_DATA_LIMITS.valueBytes;
  } catch {
    return false;
  }
}

export function isGeneratedAppDataKey(value: unknown): value is string {
  return keySchema.safeParse(value).success;
}

export function isBoundedGeneratedAppDataValue(value: unknown): value is GeneratedAppDataValue {
  return isGeneratedAppDataValue(value) && fitsValueLimit(value);
}

export function parseGeneratedAppDataValue(value: unknown): GeneratedAppDataValue | null {
  return isBoundedGeneratedAppDataValue(value) ? value : null;
}

export function parsePreviewDataRequest(value: unknown): PreviewDataRequest | null {
  const parsed = previewDataRequestSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  if (
    parsed.data.operation === "set" &&
    !isBoundedGeneratedAppDataValue(parsed.data.value)
  ) {
    return null;
  }
  return parsed.data as PreviewDataRequest;
}
