import type { GenerationInput } from "@/lib/generation/types";

export type GenerationProvider = {
  generate(input: GenerationInput): Promise<unknown>;
  repair?(
    input: GenerationInput,
    candidate: unknown,
    diagnostic: string,
  ): Promise<unknown>;
};

export const deterministicProvider: GenerationProvider = {
  async generate(input) {
    const escapedRequest = input.buildRequest
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");

    const version = (input.baseArtifact?.version ?? 0) + 1;
    return {
      "index.html": `<main class="app-shell"><p class="kicker">Deterministic v${version}</p><h1>Small idea, ready to try.</h1><p class="request">${escapedRequest}</p><div class="counter-card"><output aria-live="polite" id="count">0</output><button id="increment" type="button">Add one</button></div></main>`,
      "styles.css": `:root { color-scheme: light; font-family: system-ui, sans-serif; background: #f4f0e8; color: #1c1b1a; } body { margin: 0; min-height: 100vh; display: grid; place-items: center; } .app-shell { width: min(88%, 32rem); } .kicker { color: #a04d2c; font-size: .75rem; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; } h1 { font-size: clamp(2rem, 8vw, 4rem); line-height: .95; margin: .5rem 0 1rem; } .request { color: #665f56; line-height: 1.6; } .counter-card { align-items: center; background: #fffdf8; border: 1px solid #d8d0c4; border-radius: 1.25rem; display: flex; gap: 1rem; justify-content: space-between; margin-top: 2rem; padding: 1.25rem; } output { font-size: 2rem; font-weight: 700; } button { background: #1c1b1a; border: 0; border-radius: 999px; color: #fffdf8; cursor: pointer; padding: .75rem 1rem; } button:focus-visible { outline: 3px solid #a04d2c; outline-offset: 3px; }`,
      "app.js": `const count = document.querySelector("#count"); const increment = document.querySelector("#increment"); let value = 0; const render = () => { if (count) count.textContent = String(value); }; const restore = async () => { try { const stored = await window.minAtomsData.get("counter"); if (typeof stored === "number") value = stored; } finally { render(); } }; void restore(); increment?.addEventListener("click", async () => { const previous = value; value += 1; render(); try { await window.minAtomsData.set("counter", value); } catch { value = previous; render(); } });`,
      "manifest.json": JSON.stringify({
        name: `Deterministic v${version}`,
        version,
        entry: "index.html",
        stylesheet: "styles.css",
        script: "app.js",
        smoke: {
          selector: "#increment",
          action: "click",
          expect: {
            selector: "#count",
            text: "1",
          },
        },
      }),
    };
  },
  async repair(input) {
    return deterministicProvider.generate(input);
  },
};
