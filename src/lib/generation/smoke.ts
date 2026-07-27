import {
  getQuickJS,
  shouldInterruptAfterDeadline,
  type QuickJSRuntime,
} from "quickjs-emscripten";

import type { ArtifactFiles } from "@/lib/generation/types";
import { readArtifactManifest } from "@/lib/generation/manifest";
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

type ElementSeed = {
  attributes: Record<string, string>;
  id: string | null;
  tagName: string;
  textContent: string;
};

function getElementSeeds(html: string): ElementSeed[] {
  const seeds: ElementSeed[] = [];
  const elementPattern = /<([A-Za-z][\w:-]*)\b([^>]*)>/g;
  const attributePattern =
    /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const elementMatch of html.matchAll(elementPattern)) {
    const attributes: Record<string, string> = {};
    for (const attributeMatch of elementMatch[2].matchAll(attributePattern)) {
      attributes[attributeMatch[1].toLowerCase()] =
        attributeMatch[2] ?? attributeMatch[3] ?? attributeMatch[4] ?? "";
    }
    const id = attributes.id || null;
    seeds.push({
      attributes,
      id,
      tagName: elementMatch[1],
      textContent: id ? (getElementText(html, id) ?? "") : "",
    });
  }
  return seeds;
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
  const manifest = readArtifactManifest(files["manifest.json"]);
  if (!manifest) {
    throw new ArtifactValidationError(
      "Artifact manifest must satisfy the required contract.",
    );
  }
  const actionIds = manifest.smoke.actions.map(
    (action) => action.selector.slice(1),
  );
  const expectedId = manifest.smoke.expect.selector.slice(1);
  const expectedText = getElementText(files["index.html"], expectedId);
  for (const [index, actionId] of actionIds.entries()) {
    if (getElementText(files["index.html"], actionId) === null) {
      throw new ArtifactValidationError(
        `Artifact smoke action selector ${manifest.smoke.actions[index].selector} was not found in index.html.`,
      );
    }
  }
  if (expectedText === null) {
    throw new ArtifactValidationError(
      `Artifact smoke result selector ${manifest.smoke.expect.selector} was not found in index.html.`,
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
    const nodeSeed = JSON.stringify(getElementSeeds(files["index.html"]));
    const prelude = `
      const __allNodes = ${nodeSeed}.map((seed) => {
          const listeners = Object.create(null);
          const attributes = Object.assign(Object.create(null), seed.attributes);
          const classes = new Set((attributes.class || "").split(/\\s+/).filter(Boolean));
          const dataset = Object.create(null);
          for (const [name, value] of Object.entries(attributes)) {
            if (name.startsWith("data-")) {
              dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
            }
          }
          let node;
          node = new Proxy({
            id: seed.id || "",
            onclick: null,
            tagName: seed.tagName.toUpperCase(),
            textContent: seed.textContent,
            value: attributes.value || "",
            dataset,
            style: {},
            classList: {
              add(...names) { for (const name of names) classes.add(name); },
              contains(name) { return classes.has(name); },
              remove(...names) { for (const name of names) classes.delete(name); },
              toggle(name) {
                if (classes.has(name)) {
                  classes.delete(name);
                  return false;
                }
                classes.add(name);
                return true;
              },
            },
            getAttribute(name) { return attributes[name.toLowerCase()] ?? null; },
            setAttribute(name, value) { attributes[name.toLowerCase()] = String(value); },
            querySelector(selector) {
              return this.querySelectorAll(selector)[0] || null;
            },
            querySelectorAll(selector) {
              return __allNodes.filter((candidate) => __matches(candidate, selector));
            },
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
              if (typeof node.onclick === "function") node.onclick.call(node, event);
              for (const listener of listeners.click || []) listener.call(node, event);
            },
          }, {
            get(target, property) {
              if (property in target) return target[property];
              throw new Error("Unsupported smoke DOM API: Element." + String(property));
            },
          });
          return node;
        });
      const __nodes = Object.fromEntries(
        __allNodes.filter((node) => node.id).map((node) => [node.id, node]),
      );
      function __matches(node, selector) {
        selector = selector.trim();
        if (selector.startsWith("#")) return node.id === selector.slice(1);
        if (selector.startsWith(".")) return node.classList.contains(selector.slice(1));
        const attribute = /^\\[([\\w:-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\\]]+)))?\\]$/.exec(selector);
        if (attribute) {
          const actual = node.getAttribute(attribute[1]);
          const expected = attribute[2] ?? attribute[3] ?? attribute[4];
          return expected === undefined ? actual !== null : actual === expected.trim();
        }
        return node.tagName.toLowerCase() === selector.toLowerCase();
      }
      const document = new Proxy({
        getElementById(id) { return __nodes[id] || null; },
        querySelector(selector) {
          return this.querySelectorAll(selector)[0] || null;
        },
        querySelectorAll(selector) {
          return __allNodes.filter((node) => __matches(node, selector));
        },
        addEventListener(type, listener) {
          if (type === "DOMContentLoaded") listener({ currentTarget: document, target: document });
        },
      }, {
        get(target, property) {
          if (property in target) return target[property];
          throw new Error("Unsupported smoke DOM API: document." + String(property));
        },
      });
      const window = globalThis;
      window.document = document;
      window.addEventListener = () => {};
      window.removeEventListener = () => {};
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
    for (const actionId of actionIds) {
      context
        .unwrapResult(
          context.evalCode(`__nodes[${JSON.stringify(actionId)}].click()`),
        )
        .dispose();
      runPendingJobs(runtime);
    }

    const result = context.unwrapResult(
      context.evalCode(
        `String(__nodes[${JSON.stringify(expectedId)}].textContent).trim()`,
      ),
    );
    const actualText = context.getString(result);
    result.dispose();
    if (actualText !== manifest.smoke.expect.text) {
      const actionDescription = manifest.smoke.actions.length === 1
        ? `click ${manifest.smoke.actions[0].selector}`
        : `click sequence ${manifest.smoke.actions
            .map((action) => action.selector)
            .join(" -> ")}`;
      throw new SmokeExecutionFinding(
        `Artifact smoke ${actionDescription} did not update ${manifest.smoke.expect.selector}. Expected ${JSON.stringify(manifest.smoke.expect.text.slice(0, 80))}; received ${JSON.stringify(actualText.slice(0, 80))}.`,
      );
    }
  } catch (error) {
    const detail = error instanceof Error && error.message.trim()
      ? `Artifact smoke script failed: ${error.message.slice(0, 120)}`
      : "Artifact smoke script could not execute safely.";
    throw new ArtifactValidationError(
      error instanceof SmokeExecutionFinding
        ? error.message
        : detail,
    );
  } finally {
    context.dispose();
    runtime.dispose();
  }
}
