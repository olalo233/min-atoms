import { describe, expect, it } from "vitest";

import { deterministicProvider } from "@/lib/generation/provider";

const v1Files = {
  "app.js": "const value = 0;",
  "index.html": '<button id="increment">Add one</button><output id="count">0</output>',
  "manifest.json": JSON.stringify({
    entry: "index.html",
    ui: { preset: "min-atoms-base" },
  }),
  "styles.css": "",
};

describe("generation pipeline version context", () => {
  it("carries the selected Base Version into an immutable follow-up artifact", async () => {
    const artifact = await deterministicProvider.generate({
      baseArtifact: { files: v1Files, id: "version-1", version: 1 },
      buildRequest: "Make the counter feel celebratory.",
    });

    const files = artifact as Record<string, string>;
    expect(files["index.html"]).toContain("Deterministic v2");
    expect(files["index.html"]).toContain("Make the counter feel celebratory.");
    expect(files["app.js"]).toContain("#increment");
    expect(v1Files["index.html"]).toBe(
      '<button id="increment">Add one</button><output id="count">0</output>',
    );
  });
});
