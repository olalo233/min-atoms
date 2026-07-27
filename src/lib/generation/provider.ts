import type { GenerationInput } from "@/lib/generation/types";

export type GenerationProvider = {
  generate(input: GenerationInput): Promise<unknown>;
  repair?(
    input: GenerationInput,
    candidate: unknown,
    diagnostic: string,
  ): Promise<unknown>;
};

async function waitForDeterministicDelay() {
  const delay = Number.parseInt(
    process.env.DETERMINISTIC_GENERATION_DELAY_MS ?? "0",
    10,
  );
  if (Number.isFinite(delay) && delay > 0) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 10_000)));
  }
}

function createProgrammerCalculatorArtifact(version: number) {
  return {
    "index.html": `<main class="calculator-shell"><p class="kicker">Programmer calculator · v${version}</p><h1>Calculate with confidence.</h1><div class="calculator"><label>Left operand<input id="left" inputmode="numeric" value="7"></label><label>Operator<select id="operator" value="+"><option value="+">+</option><option value="-">−</option><option value="*">×</option><option value="/">÷</option><option value="&">&amp;</option><option value="|">|</option><option value="^">^</option></select></label><label>Right operand<input id="right" inputmode="numeric" value="1"></label><button id="calculate" type="button">Calculate</button><output aria-live="polite" id="result">8</output></div></main>`,
    "styles.css": `:root { color-scheme: dark; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #111714; color: #e7f0e9; } body { margin: 0; min-height: 100vh; display: grid; place-items: center; } .calculator-shell { width: min(90%, 42rem); } .kicker { color: #8ad6a8; font-size: .75rem; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; } h1 { font-family: system-ui, sans-serif; font-size: clamp(2rem, 7vw, 4rem); line-height: 1; margin: .5rem 0 2rem; } .calculator { background: #19221d; border: 1px solid #31443a; border-radius: 1.5rem; display: grid; gap: 1rem; grid-template-columns: 1fr auto 1fr; padding: 1.25rem; } label { color: #a9b8ae; display: grid; font-size: .75rem; gap: .5rem; } input, select { background: #0f1512; border: 1px solid #405548; border-radius: .65rem; color: inherit; font: inherit; font-size: 1.25rem; padding: .8rem; } button { background: #a4f0bf; border: 0; border-radius: .65rem; color: #102016; cursor: pointer; font: inherit; font-weight: 700; grid-column: 1 / 3; padding: .85rem 1rem; } output { align-items: center; background: #0f1512; border-radius: .65rem; display: flex; font-size: 1.5rem; justify-content: flex-end; min-height: 3rem; padding: 0 1rem; } @media (max-width: 36rem) { .calculator { grid-template-columns: 1fr; } button { grid-column: auto; } }`,
    "app.js": `const left = document.querySelector("#left"); const right = document.querySelector("#right"); const operator = document.querySelector("#operator"); const result = document.querySelector("#result"); const calculate = () => { const a = Number.parseInt(left?.value ?? "0", 10); const b = Number.parseInt(right?.value ?? "0", 10); const op = operator?.value; let value; if (op === "+") value = a + b; else if (op === "-") value = a - b; else if (op === "*") value = a * b; else if (op === "/") value = b === 0 ? "Error" : Math.trunc(a / b); else if (op === "&") value = a & b; else if (op === "|") value = a | b; else value = a ^ b; if (result) result.textContent = String(value); }; document.querySelector("#calculate")?.addEventListener("click", calculate);`,
    "manifest.json": JSON.stringify({
      name: `Programmer calculator v${version}`,
      version,
      entry: "index.html",
      ui: { preset: "bootstrap-5" },
      stylesheet: "styles.css",
      script: "app.js",
      smoke: {
        selector: "#calculate",
        action: "click",
        expect: {
          selector: "#result",
          text: "8",
        },
      },
    }),
  };
}

export const deterministicProvider: GenerationProvider = {
  async generate(input) {
    await waitForDeterministicDelay();
    const escapedRequest = input.buildRequest
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");

    const version = (input.baseArtifact?.version ?? 0) + 1;
    if (/programmer calculator|程序员计算器/i.test(input.buildRequest)) {
      return createProgrammerCalculatorArtifact(version);
    }
    return {
      "index.html": `<main class="app-shell"><p class="kicker">Deterministic v${version}</p><h1>Small idea, ready to try.</h1><p class="request">${escapedRequest}</p><div class="counter-card"><output aria-live="polite" id="count">0</output><button id="increment" type="button">Add one</button></div></main>`,
      "styles.css": `:root { color-scheme: light; font-family: system-ui, sans-serif; background: #f4f0e8; color: #1c1b1a; } body { margin: 0; min-height: 100vh; display: grid; place-items: center; } .app-shell { width: min(88%, 32rem); } .kicker { color: #a04d2c; font-size: .75rem; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; } h1 { font-size: clamp(2rem, 8vw, 4rem); line-height: .95; margin: .5rem 0 1rem; } .request { color: #665f56; line-height: 1.6; } .counter-card { align-items: center; background: #fffdf8; border: 1px solid #d8d0c4; border-radius: 1.25rem; display: flex; gap: 1rem; justify-content: space-between; margin-top: 2rem; padding: 1.25rem; } output { font-size: 2rem; font-weight: 700; } button { background: #1c1b1a; border: 0; border-radius: 999px; color: #fffdf8; cursor: pointer; padding: .75rem 1rem; } button:focus-visible { outline: 3px solid #a04d2c; outline-offset: 3px; }`,
      "app.js": `const count = document.querySelector("#count"); const increment = document.querySelector("#increment"); let value = 0; const render = () => { if (count) count.textContent = String(value); }; const restore = async () => { try { const stored = await window.minAtomsData.get("counter"); if (typeof stored === "number") value = stored; } finally { render(); } }; void restore(); increment?.addEventListener("click", async () => { const previous = value; value += 1; render(); try { await window.minAtomsData.set("counter", value); } catch { value = previous; render(); } });`,
      "manifest.json": JSON.stringify({
        name: `Deterministic v${version}`,
        version,
        entry: "index.html",
        ui: { preset: "pico-2" },
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
