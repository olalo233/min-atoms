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

  it("executes a bounded click sequence for a natural calculator interaction", async () => {
    const files = {
      ...(await validFiles()),
      "index.html": `
        <button id="digit-7">7</button>
        <button id="operator-add">+</button>
        <button id="digit-1">1</button>
        <button id="equals">=</button>
        <output id="count">0</output>
      `,
      "app.js": `
        let expression = "";
        document.querySelector("#digit-7").addEventListener("click", () => {
          expression += "7";
        });
        document.querySelector("#operator-add").addEventListener("click", () => {
          expression += "+";
        });
        document.querySelector("#digit-1").addEventListener("click", () => {
          expression += "1";
        });
        document.querySelector("#equals").addEventListener("click", () => {
          document.querySelector("#count").textContent =
            expression === "7+1" ? "8" : "Error";
        });
      `,
      "manifest.json": JSON.stringify({
        entry: "index.html",
        ui: { preset: "min-atoms-base" },
        smoke: {
          actions: [
            { action: "click", selector: "#digit-7" },
            { action: "click", selector: "#operator-add" },
            { action: "click", selector: "#digit-1" },
            { action: "click", selector: "#equals" },
          ],
          expect: { selector: "#count", text: "8" },
        },
      }),
    };

    await expect(
      validateArtifactSmoke(validateArtifact(files)),
    ).resolves.toBeUndefined();
  });

  it("rejects a parseable artifact whose declared click does not work", async () => {
    const files = {
      ...(await validFiles()),
      "app.js": 'document.querySelector("#count").textContent = "0";',
    };

    await expect(validateArtifactSmoke(files)).rejects.toThrow(
      'Artifact smoke click #increment did not update #count. Expected "1"; received "0".',
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
    ).rejects.toThrow(
      "Artifact smoke action selector #missing was not found in index.html.",
    );
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

  it("supports bounded querySelectorAll calls before the smoke interaction", async () => {
    const files = {
      ...(await validFiles()),
      "index.html": `
        <button class="calculator-key" data-value="1" id="increment">Increment</button>
        <output id="count">0</output>
      `,
      "app.js": `
        document.addEventListener("DOMContentLoaded", () => {
          document.querySelectorAll(".calculator-key").forEach((button) => {
            button.addEventListener("click", () => {
              document.querySelector("[data-value='1']").textContent = "used";
              document.querySelector("#count").textContent =
                button.getAttribute("data-value");
            });
          });
        });
      `,
    };

    await expect(validateArtifactSmoke(files)).resolves.toBeUndefined();
  });

  it("supports bounded Element querySelectorAll calls used to bind keypad controls", async () => {
    const files = {
      ...(await validFiles()),
      "index.html": `
        <section id="keypad">
          <button class="calculator-key" data-value="1" id="increment">Increment</button>
        </section>
        <output id="count">0</output>
      `,
      "app.js": `
        const keypad = document.querySelector("#keypad");
        keypad.querySelectorAll(".calculator-key").forEach((button) => {
          button.addEventListener("click", () => {
            document.querySelector("#count").textContent =
              button.getAttribute("data-value");
          });
        });
      `,
    };

    await expect(validateArtifactSmoke(files)).resolves.toBeUndefined();
  });

  it("binds event-listener this to the clicked element", async () => {
    const files = {
      ...(await validFiles()),
      "index.html": `
        <button class="calculator-key" data-value="1" id="increment">Increment</button>
        <output id="count">0</output>
      `,
      "app.js": `
        document.querySelectorAll(".calculator-key").forEach((button) => {
          button.addEventListener("click", function () {
            document.querySelector("#count").textContent = this.dataset.value;
          });
        });
      `,
    };

    await expect(validateArtifactSmoke(files)).resolves.toBeUndefined();
  });

  it("seeds non-smoke ID elements used during application setup", async () => {
    const files = {
      ...(await validFiles()),
      "index.html": `
        <main>
          <output id="display">0</output>
          <button id="increment">Increment</button>
          <output id="count">0</output>
        </main>
      `,
      "app.js": `
        document.addEventListener("DOMContentLoaded", () => {
          document.getElementById("display").textContent = "READY";
          const count = document.getElementById("count");
          document.getElementById("increment").addEventListener("click", () => {
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

  it("names an unsupported DOM API in the repair diagnostic", async () => {
    const files = {
      ...(await validFiles()),
      "app.js": `
        document.querySelector("#increment").addEventListener("click", () => {
          document.createElement("span");
        });
      `,
    };

    await expect(validateArtifactSmoke(files)).rejects.toThrow(
      "Artifact smoke script failed: Unsupported smoke DOM API: document.createElement",
    );
  });

  it("names an unsupported Element API in the repair diagnostic", async () => {
    const files = {
      ...(await validFiles()),
      "app.js": `
        document.querySelector("#increment").addEventListener("click", () => {
          document.querySelector("#count").replaceChildren("1");
        });
      `,
    };

    await expect(validateArtifactSmoke(files)).rejects.toThrow(
      "Artifact smoke script failed: Unsupported smoke DOM API: Element.replaceChildren",
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
