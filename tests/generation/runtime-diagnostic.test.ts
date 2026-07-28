import { describe, expect, it } from "vitest";

import { parseRuntimeDiagnostic } from "@/lib/generation/runtime-diagnostic";

describe("runtime diagnostic contract", () => {
  it("accepts one bounded real-browser error", () => {
    expect(
      parseRuntimeDiagnostic({
        artifactVersionId: "version-1",
        detail: "TypeError: canvas.getContext is not a function",
        kind: "error",
        projectId: "project-1",
        type: "min-atoms-runtime-diagnostic",
      }),
    ).toEqual({
      artifactVersionId: "version-1",
      detail: "TypeError: canvas.getContext is not a function",
      kind: "error",
      projectId: "project-1",
      type: "min-atoms-runtime-diagnostic",
    });
  });

  it("accepts a platform-detected reload loop", () => {
    expect(
      parseRuntimeDiagnostic({
        artifactVersionId: "version-1",
        detail:
          "Artifact repeatedly reloaded its preview document. Update the current DOM instead of calling location.reload().",
        kind: "reload_loop",
        projectId: "project-1",
        type: "min-atoms-runtime-diagnostic",
      }),
    ).toMatchObject({
      kind: "reload_loop",
      projectId: "project-1",
    });
  });

  it("rejects malformed identities and empty diagnostics while bounding detail", () => {
    expect(
      parseRuntimeDiagnostic({
        artifactVersionId: "version/other",
        detail: "broken",
        kind: "error",
        projectId: "project-1",
        type: "min-atoms-runtime-diagnostic",
      }),
    ).toBeNull();
    expect(
      parseRuntimeDiagnostic({
        artifactVersionId: "version-1",
        detail: " ",
        kind: "error",
        projectId: "project-1",
        type: "min-atoms-runtime-diagnostic",
      }),
    ).toBeNull();
    expect(
      parseRuntimeDiagnostic({
        artifactVersionId: "version-1",
        detail: "x".repeat(1_000),
        kind: "unhandledrejection",
        projectId: "project-1",
        type: "min-atoms-runtime-diagnostic",
      })?.detail,
    ).toHaveLength(640);
  });
});
