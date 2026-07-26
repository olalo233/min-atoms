import {
  getQuickJS,
  shouldInterruptAfterDeadline,
  type QuickJSRuntime,
} from "quickjs-emscripten";

import type { ArtifactFiles } from "@/lib/generation/types";
import { ArtifactValidationError } from "@/lib/generation/validator";

const SMOKE_TIMEOUT_MS = 500;
const MEMORY_LIMIT_BYTES = 8 * 1024 * 1024;
const STACK_LIMIT_BYTES = 512 * 1024;

class SmokeExecutionFinding extends Error {}

function decodeText(value: string): string {
  return value
    .replace(/<[^>]*>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .trim();
}

function getElementText(html: string, id: string): string | null {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const element = new RegExp(
    `<([A-Za-z][\\w:-]*)\\b[^>]*\\bid=(?:"${escapedId}"|'${escapedId}')[^>]*>([\\s\\S]*?)<\\/\\1>`,
    "i",
  ).exec(html);
  return element ? decodeText(element[2]) : null;
}

function getElementSeed(html: string): Record<string, string> {
  const seed: Record<string, string> = {};
  const idPattern = /\bid=(?:"([^"]+)"|'([^']+)')/gi;
  for (const match of html.matchAll(idPattern)) {
    const id = match[1] ?? match[2];
    if (id && !(id in seed)) {
      seed[id] = getElementText(html, id) ?? "";
    }
  }
  return seed;
}

function runPendingJobs(runtime: QuickJSRuntime) {
  for (let iteration = 0; iteration < 16 && runtime.hasPendingJob(); iteration += 1) {
    const result = runtime.executePendingJobs();
    if (result.error) {
      result.error.dispose();
      throw new Error("pending job failed");
    }
  }
  if (runtime.hasPendingJob()) {
    throw new Error("pending jobs did not settle");
  }
}

export async function validateArtifactSmoke(files: ArtifactFiles): Promise<void> {
  const manifest = JSON.parse(files["manifest.json"]) as {
    smoke: {
      expect: { selector: string; text: string };
      selector: string;
    };
  };
  const actionId = manifest.smoke.selector.slice(1);
  const expectedId = manifest.smoke.expect.selector.slice(1);
  const actionText = getElementText(files["index.html"], actionId);
  const expectedText = getElementText(files["index.html"], expectedId);
  if (actionText === null) {
    throw new ArtifactValidationError(
      "Artifact smoke action selector was not found.",
    );
  }
  if (expectedText === null) {
    throw new ArtifactValidationError(
      "Artifact smoke result selector was not found.",
    );
  }

  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(MEMORY_LIMIT_BYTES);
  runtime.setMaxStackSize(STACK_LIMIT_BYTES);
  runtime.setInterruptHandler(
    shouldInterruptAfterDeadline(Date.now() + SMOKE_TIMEOUT_MS),
  );
  const context = runtime.newContext();

  try {
    const nodeSeed = JSON.stringify(getElementSeed(files["index.html"]));
    const prelude = `
      const __nodes = Object.fromEntries(
        Object.entries(${nodeSeed}).map(([id, textContent]) => {
          const listeners = Object.create(null);
          const node = {
            id,
            textContent,
            value: "",
            classList: { add() {}, remove() {}, toggle() {} },
            addEventListener(type, listener) {
              (listeners[type] ||= []).push(listener);
            },
            removeEventListener(type, listener) {
              listeners[type] = (listeners[type] || []).filter((item) => item !== listener);
            },
            click() {
              const event = {
                currentTarget: node,
                target: node,
                preventDefault() {},
                stopPropagation() {},
              };
              if (typeof node.onclick === "function") node.onclick(event);
              for (const listener of listeners.click || []) listener(event);
            },
          };
          return [id, node];
        }),
      );
      const document = {
        getElementById(id) { return __nodes[id] || null; },
        querySelector(selector) {
          return selector.startsWith("#") ? (__nodes[selector.slice(1)] || null) : null;
        },
        querySelectorAll(selector) {
          const node = this.querySelector(selector);
          return node ? [node] : [];
        },
        addEventListener(type, listener) {
          if (type === "DOMContentLoaded") listener({ currentTarget: document, target: document });
        },
      };
      const window = globalThis;
      window.document = document;
      window.minAtomsData = {
        delete: async () => true,
        get: async () => null,
        list: async () => ({}),
        set: async () => true,
      };
    `;
    const evaluation = context.evalCode(`${prelude}\n${files["app.js"]}`);
    const evaluationError = evaluation.error;
    if (evaluationError) {
      const dumped = context.dump(evaluationError) as {
        message?: unknown;
        name?: unknown;
      };
      evaluationError.dispose();
      const detail = typeof dumped.message === "string"
        ? dumped.message
        : typeof dumped.name === "string"
          ? dumped.name
          : "unknown runtime error";
      throw new SmokeExecutionFinding(
        `Artifact smoke script failed: ${detail.slice(0, 120)}`,
      );
    }
    context.unwrapResult(evaluation).dispose();
    runPendingJobs(runtime);
    context
      .unwrapResult(
        context.evalCode(`__nodes[${JSON.stringify(actionId)}].click()`),
      )
      .dispose();
    runPendingJobs(runtime);

    const result = context.unwrapResult(
      context.evalCode(
        `String(__nodes[${JSON.stringify(expectedId)}].textContent).trim()`,
      ),
    );
    const actualText = context.getString(result);
    result.dispose();
    if (actualText !== manifest.smoke.expect.text) {
      throw new SmokeExecutionFinding(
        "Artifact smoke click did not produce the expected text.",
      );
    }
  } catch (error) {
    throw new ArtifactValidationError(
      error instanceof SmokeExecutionFinding
        ? error.message
        : "Artifact smoke script could not execute safely.",
    );
  } finally {
    context.dispose();
    runtime.dispose();
  }
}
