import { describe, expect, it } from "vitest";

import {
  GENERATED_APP_DATA_LIMITS,
  parseGeneratedAppDataValue,
  parsePreviewDataRequest,
} from "@/lib/generated-app-data/contract";

describe("Generated App Data contract", () => {
  it("accepts bounded get, list, set, and delete requests", () => {
    const base = {
      artifactVersionId: "version-1",
      projectId: "project-1",
      requestId: "request-1",
      type: "min-atoms-data-request",
    };

    expect(parsePreviewDataRequest({ ...base, operation: "get", key: "counter" })).toMatchObject({
      operation: "get",
      key: "counter",
    });
    expect(parsePreviewDataRequest({ ...base, operation: "list" })).toMatchObject({
      operation: "list",
    });
    expect(parsePreviewDataRequest({ ...base, operation: "set", key: "counter", value: 2 })).toMatchObject({
      operation: "set",
      key: "counter",
      value: 2,
    });
    expect(parsePreviewDataRequest({ ...base, operation: "delete", key: "counter" })).toMatchObject({
      operation: "delete",
      key: "counter",
    });
  });

  it("rejects malformed request ids, unknown fields, and oversized keys or values", () => {
    const request = {
      artifactVersionId: "version-1",
      key: "counter",
      operation: "set",
      projectId: "project-1",
      requestId: "request-1",
      type: "min-atoms-data-request",
      value: 1,
    };

    expect(parsePreviewDataRequest({ ...request, requestId: "" })).toBeNull();
    expect(parsePreviewDataRequest({ ...request, extra: true })).toBeNull();
    expect(
      parsePreviewDataRequest({
        ...request,
        key: "k".repeat(GENERATED_APP_DATA_LIMITS.keyLength + 1),
      }),
    ).toBeNull();
    expect(
      parsePreviewDataRequest({
        ...request,
        value: "v".repeat(GENERATED_APP_DATA_LIMITS.valueBytes + 1),
      }),
    ).toBeNull();
  });

  it("allows JSON values but rejects values outside the persisted JSON contract", () => {
    expect(parseGeneratedAppDataValue({ count: 1, enabled: true })).toEqual({
      count: 1,
      enabled: true,
    });
    expect(parseGeneratedAppDataValue(undefined)).toBeNull();
    expect(parseGeneratedAppDataValue(() => undefined)).toBeNull();

    let deeplyNested: unknown = 1;
    for (
      let depth = 0;
      depth <= GENERATED_APP_DATA_LIMITS.valueDepth;
      depth += 1
    ) {
      deeplyNested = [deeplyNested];
    }
    expect(parseGeneratedAppDataValue(deeplyNested)).toBeNull();
  });
});
