import { describe, expect, it } from "vitest";

import { deterministicProvider } from "@/lib/generation/provider";
import { validateArtifactSmoke } from "@/lib/generation/smoke";
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
    ).toThrow("required contract");
  });

  it("accepts only platform-controlled UI presets", () => {
    const artifact = {
      "app.js": "",
      "index.html": '<button id="go">Go</button><output id="result">0</output>',
      "styles.css": "",
      "manifest.json": "",
    };
    const manifest = {
      entry: "index.html",
      smoke: {
        action: "click",
        expect: { selector: "#result", text: "1" },
        selector: "#go",
      },
    };

    expect(() => validateArtifact({
      ...artifact,
      "manifest.json": JSON.stringify({
        ...manifest,
        ui: { preset: "untrusted-framework" },
      }),
    })).toThrow("required contract");
    expect(() => validateArtifact({
      ...artifact,
      "manifest.json": JSON.stringify({
        ...manifest,
        ui: { preset: "pico-2", url: "https://untrusted.example/framework.css" },
      }),
    })).toThrow("forbidden capability");
  });

  it("escapes the request before placing it in generated HTML", async () => {
    const artifact = await deterministicProvider.generate({ baseArtifact: null, buildRequest: "<script>alert(1)</script>" });

    expect(artifact["index.html"]).not.toContain("<script>alert(1)</script>");
    expect(artifact["index.html"]).toContain("&lt;script&gt;");
  });

  it("accepts the deterministic programmer calculator interaction", async () => {
    const artifact = await deterministicProvider.generate({
      baseArtifact: null,
      buildRequest: "Build a programmer calculator",
    });

    await expect(validateArtifactSmoke(validateArtifact(artifact))).resolves.toBeUndefined();
  });

  it("rejects forbidden network capabilities and malformed JavaScript", () => {
    const valid = {
      "app.js": "const result = document.querySelector('#result');",
      "index.html": "<button id=\"go\">Go</button><output id=\"result\">0</output>",
      "manifest.json": JSON.stringify({
        entry: "index.html",
        ui: { preset: "min-atoms-base" },
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

  it("allows class constructors while blocking constructor-chain escapes", () => {
    const valid = {
      "app.js": "class Calculator { constructor() { this.value = 0; } }",
      "index.html": "<button id=\"go\">Go</button><output id=\"result\">0</output>",
      "manifest.json": JSON.stringify({
        entry: "index.html",
        ui: { preset: "min-atoms-base" },
        smoke: {
          action: "click",
          expect: { selector: "#result", text: "1" },
          selector: "#go",
        },
      }),
      "styles.css": ".app { color: black; }",
    };

    expect(validateArtifact(valid)).toEqual(valid);
    expect(() =>
      validateArtifact({
        ...valid,
        "app.js": "({}).constructor.constructor('return globalThis')()",
      }),
    ).toThrow("forbidden runtime escape");
    expect(() =>
      validateArtifact({
        ...valid,
        "app.js": "const escape = value['prototype'];",
      }),
    ).toThrow("forbidden runtime escape");
  });
});
