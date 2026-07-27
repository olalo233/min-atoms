import { describe, expect, it } from "vitest";

import { deterministicProvider } from "@/lib/generation/provider";
import { validateArtifactSmoke } from "@/lib/generation/smoke";
import {
  getValidationDiagnostic,
  validateArtifact,
} from "@/lib/generation/validator";

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
    })).toThrow("required contract");
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

  it("leaves browser capability containment to Preview while checking syntax", () => {
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

    expect(
      validateArtifact({
        ...valid,
        "app.js":
          "fetch('https://example.test'); window.open('https://example.test');",
        "index.html":
          '<form action="https://example.test"><a href="https://example.test"><img src="https://example.test/image.png" alt="">Open</a></form><script>document.body.dataset.inline = "yes"</script>',
      }),
    ).toMatchObject({
      "app.js": expect.stringContaining("fetch"),
      "index.html": expect.stringContaining("href"),
    });
    expect(() => validateArtifact({ ...valid, "app.js": "const = ;" })).toThrow(
      "parseable JavaScript",
    );
    expect(() =>
      validateArtifact({ ...valid, "styles.css": "} .app {" }),
    ).toThrow("balanced blocks");
  });

  it("allows self-contained fragment navigation inside a generated SPA", () => {
    const artifact = {
      "app.js":
        "document.querySelector('#go')?.addEventListener('click', () => { document.querySelector('#result').textContent = '1'; });",
      "index.html":
        '<nav><a href="#">Home</a><a href="#blog">Blog</a></nav><svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M0 0h1v1H0z"></path></svg><section id="home"><button id="go">Go</button><output id="result">0</output></section><section id="blog">Posts</section>',
      "manifest.json": JSON.stringify({
        entry: "index.html",
        ui: { preset: "min-atoms-base" },
        smoke: {
          action: "click",
          expect: { selector: "#result", text: "1" },
          selector: "#go",
        },
      }),
      "styles.css": "section { min-height: 10rem; }",
    };

    expect(validateArtifact(artifact)).toEqual(artifact);
  });

  it("accepts a browser-native Canvas game without a QuickJS smoke contract", () => {
    const artifact = {
      "app.js": `
        const canvas = document.querySelector("#game");
        const context = canvas.getContext("2d");
        window.addEventListener("keydown", () => requestAnimationFrame(() => {
          context.fillRect(0, 0, 12, 12);
        }));
      `,
      "index.html": '<canvas id="game" width="320" height="320"></canvas>',
      "manifest.json": JSON.stringify({
        entry: "index.html",
        ui: { preset: "min-atoms-base" },
      }),
      "styles.css": "canvas { inline-size: min(100%, 32rem); }",
    };

    expect(validateArtifact(artifact)).toEqual(artifact);
  });

  it("reports all deterministic findings in one bounded repair diagnostic", () => {
    let diagnostic = "";
    try {
      validateArtifact({
        "app.js": "const = ;",
        "index.html": '<form id="unsafe"></form>',
        "manifest.json": "{}",
        "styles.css": "}",
      });
    } catch (error) {
      diagnostic = getValidationDiagnostic(error);
    }

    expect(diagnostic).toContain("manifest must satisfy the required contract");
    expect(diagnostic).toContain("app.js must be parseable JavaScript");
    expect(diagnostic).toContain("styles.css must have balanced blocks");
    expect(diagnostic.length).toBeLessThanOrEqual(640);
  });

  it("leaves runtime escape containment to the sandbox CSP", () => {
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
    expect(
      validateArtifact({
        ...valid,
        "app.js": "({}).constructor.constructor('return globalThis')()",
      }),
    ).toMatchObject({
      "app.js": expect.stringContaining("constructor.constructor"),
    });
  });
});
