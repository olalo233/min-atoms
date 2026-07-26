import { describe, expect, it } from "vitest";

import { deterministicProvider } from "@/lib/generation/provider";
import { validateArtifact } from "@/lib/generation/validator";

describe("deterministic artifact contract", () => {
  it("accepts exactly the four provider files", async () => {
    const artifact = await deterministicProvider.generate({ baseArtifact: null, buildRequest: "Make a timer" });

    expect(Object.keys(artifact).sort()).toEqual([
      "app.js",
      "index.html",
      "manifest.json",
      "styles.css",
    ]);
    expect(validateArtifact(artifact)).toEqual(artifact);
  });

  it("rejects extra files and invalid manifests", () => {
    expect(() =>
      validateArtifact({
        "app.js": "",
        "index.html": "",
        "manifest.json": "{}",
        "styles.css": "",
        "unexpected.txt": "no",
      }),
    ).toThrow("exactly the four approved files");

    expect(() =>
      validateArtifact({
        "app.js": "",
        "index.html": "",
        "manifest.json": "not json",
        "styles.css": "",
      }),
    ).toThrow("valid JSON");
  });

  it("escapes the request before placing it in generated HTML", async () => {
    const artifact = await deterministicProvider.generate({ baseArtifact: null, buildRequest: "<script>alert(1)</script>" });

    expect(artifact["index.html"]).not.toContain("<script>alert(1)</script>");
    expect(artifact["index.html"]).toContain("&lt;script&gt;");
  });

  it("rejects forbidden network capabilities and malformed JavaScript", () => {
    const valid = {
      "app.js": "const result = document.querySelector('#result');",
      "index.html": "<button id=\"go\">Go</button><output id=\"result\">0</output>",
      "manifest.json": JSON.stringify({
        entry: "index.html",
        smoke: {
          action: "click",
          expect: { selector: "#result", text: "1" },
          selector: "#go",
        },
      }),
      "styles.css": ".app { color: black; }",
    };

    expect(() =>
      validateArtifact({ ...valid, "app.js": "fetch('https://example.test')" }),
    ).toThrow("forbidden capability");
    expect(() => validateArtifact({ ...valid, "app.js": "const = ;" })).toThrow(
      "parseable JavaScript",
    );
    expect(() =>
      validateArtifact({
        ...valid,
        "index.html": "<script>document.body.textContent = 'unsafe'</script>",
      }),
    ).toThrow("forbidden capability");
    expect(() =>
      validateArtifact({ ...valid, "styles.css": "} .app {" }),
    ).toThrow("balanced blocks");
  });
});
