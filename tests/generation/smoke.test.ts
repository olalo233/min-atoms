import { describe, expect, it } from "vitest";

import { deterministicProvider } from "@/lib/generation/provider";
import { validateArtifactSmoke } from "@/lib/generation/smoke";
import { validateArtifact } from "@/lib/generation/validator";

async function validFiles() {
  return validateArtifact(
    await deterministicProvider.generate({
      baseArtifact: null,
      buildRequest: "Build a counter",
    }),
  );
}

describe("artifact smoke validation", () => {
  it("executes the declared interaction and accepts the observed result", async () => {
    await expect(validateArtifactSmoke(await validFiles())).resolves.toBeUndefined();
  });

  it("rejects a parseable artifact whose declared click does not work", async () => {
    const files = {
      ...(await validFiles()),
      "app.js": 'document.querySelector("#count").textContent = "0";',
    };

    await expect(validateArtifactSmoke(files)).rejects.toThrow(
      "Artifact smoke click did not produce the expected text.",
    );
  });

  it("rejects a manifest that points at a missing action target", async () => {
    const files = await validFiles();
    const manifest = JSON.parse(files["manifest.json"]) as {
      smoke: { selector: string };
    };
    manifest.smoke.selector = "#missing";

    await expect(
      validateArtifactSmoke({
        ...files,
        "manifest.json": JSON.stringify(manifest),
      }),
    ).rejects.toThrow("Artifact smoke action selector was not found.");
  });

  it("interrupts generated code that exceeds the execution deadline", async () => {
    const files = {
      ...(await validFiles()),
      "app.js": "while (true) {}",
    };

    await expect(validateArtifactSmoke(files)).rejects.toThrow(
      "Artifact smoke script failed: interrupted",
    );
  });

  it("runs a DOMContentLoaded wrapper before the declared interaction", async () => {
    const files = {
      ...(await validFiles()),
      "app.js": `
        document.addEventListener("DOMContentLoaded", () => {
          const count = document.querySelector("#count");
          document.querySelector("#increment").addEventListener("click", () => {
            count.textContent = "1";
          });
        });
      `,
    };

    await expect(validateArtifactSmoke(files)).resolves.toBeUndefined();
  });

  it("returns an actionable diagnostic for an undeclared runtime global", async () => {
    const files = {
      ...(await validFiles()),
      "app.js": "marked.parse('# title');",
    };

    await expect(validateArtifactSmoke(files)).rejects.toThrow(
      /Artifact smoke script failed:.*marked.*not defined/i,
    );
  });

  it("does not expose the Node process to generated code", async () => {
    const files = await validFiles();
    const manifest = JSON.parse(files["manifest.json"]) as {
      smoke: { expect: { text: string } };
    };
    manifest.smoke.expect.text = "undefined";

    await expect(
      validateArtifactSmoke({
        ...files,
        "app.js": `
          const count = document.querySelector("#count");
          document.querySelector("#increment").addEventListener("click", () => {
            count.textContent = typeof globalThis["pro" + "cess"];
          });
        `,
        "manifest.json": JSON.stringify(manifest),
      }),
    ).resolves.toBeUndefined();
  });
});
