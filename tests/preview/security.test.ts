import { describe, expect, it } from "vitest";

import {
  buildPreviewDocument,
  PREVIEW_SANDBOX,
} from "@/components/preview/preview-frame";
import { deterministicProvider } from "@/lib/generation/provider";

describe("preview security boundary", () => {
  it("grants scripts without same-origin, navigation, popup, form, or download capabilities", () => {
    expect(PREVIEW_SANDBOX).toBe("allow-scripts");
    expect(PREVIEW_SANDBOX).not.toMatch(
      /allow-same-origin|allow-top-navigation|allow-popups|allow-forms|allow-downloads/,
    );
  });

  it("uses a restrictive CSP for the artifact document", async () => {
    const files = await deterministicProvider.generate({ baseArtifact: null, buildRequest: "Make a timer" });
    const document = buildPreviewDocument(files);

    expect(document).toContain('<base href="about:srcdoc">');
    expect(document.indexOf('<base href="about:srcdoc">')).toBeLessThan(
      document.indexOf('http-equiv="Content-Security-Policy"'),
    );
    expect(document).toContain("default-src 'none'");
    expect(document).toContain("connect-src 'none'");
    expect(document).toContain("frame-src 'none'");
    expect(document).toContain("form-action 'none'");
    expect(document).toContain("base-uri 'none'");
    expect(document).toContain("https://cdn.jsdelivr.net/npm/@picocss/pico@2.1.1/css/pico.min.css");
    expect(document).toContain("style-src 'unsafe-inline' https://cdn.jsdelivr.net");
    expect(document).not.toContain("script-src 'unsafe-inline' https://cdn.jsdelivr.net");
    expect(document).toContain("window.minAtomsData");
    expect(document).toContain("min-atoms-data-request");
    expect(files["app.js"]).toContain("window.minAtomsData.get(\"counter\")");
    expect(files["app.js"]).toContain("window.minAtomsData.set(\"counter\", value)");
  });

  it("keeps the dependency-free preset offline", async () => {
    const files = await deterministicProvider.generate({ baseArtifact: null, buildRequest: "Make a timer" });
    const manifest = JSON.parse(files["manifest.json"]);
    manifest.ui = { preset: "min-atoms-base" };
    const document = buildPreviewDocument({
      ...files,
      "manifest.json": JSON.stringify(manifest),
    });

    expect(document).toContain("style-src 'unsafe-inline'; img-src data:");
    expect(document).not.toContain("cdn.jsdelivr.net");
  });
});
