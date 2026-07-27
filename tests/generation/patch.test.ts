import { describe, expect, it } from "vitest";

import { applyArtifactRepair } from "@/lib/generation/patch";
import type { ArtifactFiles } from "@/lib/generation/types";

const candidate: ArtifactFiles = {
  "app.js": "const result = 0;",
  "index.html": '<output id="result">0</output>',
  "manifest.json": "{}",
  "styles.css": "output { color: black; }",
};

describe("incremental Artifact Repair", () => {
  it("materializes a complete new Candidate Artifact without mutating the prior candidate", () => {
    const result = applyArtifactRepair(candidate, {
      operations: [
        {
          op: "replace-file",
          path: "app.js",
          content: 'document.querySelector("#result").textContent = "8";',
        },
      ],
    });

    expect(result.files).toEqual({
      ...candidate,
      "app.js": 'document.querySelector("#result").textContent = "8";',
    });
    expect(result.patch.operations).toHaveLength(1);
    expect(candidate["app.js"]).toBe("const result = 0;");
  });

  it.each([
    [{ operations: [] }, "between one and four"],
    [
      {
        operations: [
          { op: "replace-file", path: "app.js", content: "one" },
          { op: "replace-file", path: "app.js", content: "two" },
        ],
      },
      "only once",
    ],
    [
      {
        operations: [
          { op: "replace-file", path: "README.md", content: "unsafe" },
        ],
      },
      "approved Artifact file",
    ],
    [
      {
        operations: [
          {
            op: "replace-file",
            path: "app.js",
            content: "safe",
            unexpected: true,
          },
        ],
      },
      "exact operation contract",
    ],
    [
      {
        operations: [
          { op: "replace-file", path: "app.js", content: 42 },
        ],
      },
      "bounded string content",
    ],
    [
      {
        operations: [
          { op: "replace-file", path: "app.js", content: "x".repeat(40_001) },
        ],
      },
      "bounded string content",
    ],
    [{ operations: [], extra: true }, "exact patch contract"],
  ])("rejects an invalid patch response", (response, message) => {
    expect(() => applyArtifactRepair(candidate, response)).toThrow(message);
  });
});
