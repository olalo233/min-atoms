import { ARTIFACT_FILES, type ArtifactFiles } from "@/lib/generation/types";
import { readArtifactManifest } from "@/lib/generation/manifest";

const MAX_FILE_SIZE = 40_000;
const MAX_DIAGNOSTIC_SIZE = 640;
const FORBIDDEN_CONTENT = [
  /https?:\/\//i,
  /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|importScripts)\s*\(/i,
  /\b(?:window\.open|Worker|SharedWorker)\s*\(/i,
  /\bnavigator\.(?:mediaDevices|geolocation|permissions|serviceWorker|sendBeacon)\b/i,
  /\bimport\s*\(/i,
  /<\s*(?:base|embed|form|iframe|link|object|script)\b/i,
  /<\s*meta\b[^>]*http-equiv/i,
  /@import\b/i,
  /\burl\s*\(/i,
  /\b(?:src|href)\s*=/i,
];
const FORBIDDEN_SCRIPT_CONTENT = [
  /\b(?:eval|process|require|module|global|Buffer)\b/i,
  /\bFunction\b/,
  /\b__proto__\b/i,
  /\.\s*(?:constructor|prototype)\b/i,
  /\[\s*["'](?:constructor|prototype|__proto__)["']\s*\]/i,
];

export class ArtifactValidationError extends Error {
  readonly category = "artifact_invalid";

  constructor(message: string) {
    super(message);
    this.name = "ArtifactValidationError";
  }
}

function reject(message: string): never {
  throw new ArtifactValidationError(message);
}

export function getValidationDiagnostic(error: unknown): string {
  if (error instanceof ArtifactValidationError) {
    return error.message.slice(0, MAX_DIAGNOSTIC_SIZE);
  }
  return "Artifact did not satisfy the required contract.";
}

export function validateArtifact(input: unknown): ArtifactFiles {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    reject("Artifact must be a file object.");
  }

  const files = input as Record<string, unknown>;
  const findings: string[] = [];
  const names = Object.keys(files).sort();
  const expectedNames = [...ARTIFACT_FILES].sort();
  if (
    names.length !== expectedNames.length ||
    names.some((name, index) => name !== expectedNames[index])
  ) {
    findings.push("Artifact must contain exactly the four approved files.");
  }

  for (const name of ARTIFACT_FILES) {
    const value = files[name];
    if (typeof value !== "string" || value.length > MAX_FILE_SIZE) {
      findings.push(`Artifact file ${name} is invalid.`);
      continue;
    }
    if (FORBIDDEN_CONTENT.some((pattern) => pattern.test(value))) {
      findings.push(`Artifact file ${name} uses a forbidden capability.`);
    }
  }
  if (typeof files["app.js"] === "string" &&
    FORBIDDEN_SCRIPT_CONTENT.some((pattern) =>
      pattern.test(files["app.js"] as string),
    )
  ) {
    findings.push("Artifact app.js uses a forbidden runtime escape.");
  }

  const manifest = typeof files["manifest.json"] === "string"
    ? readArtifactManifest(files["manifest.json"])
    : null;
  if (!manifest) {
    findings.push("Artifact manifest must satisfy the required contract.");
  } else {
    const smokeContract = manifest.smoke;
    const idSelector = /^#[A-Za-z][\w:-]{0,63}$/;
    if (
      !idSelector.test(smokeContract.selector) ||
      !idSelector.test(smokeContract.expect.selector) ||
      smokeContract.expect.text.length === 0 ||
      smokeContract.expect.text.length > 256
    ) {
      findings.push(
        "Artifact smoke interaction must use bounded ID selectors and text.",
      );
    }
  }

  if (typeof files["app.js"] === "string") {
    try {
      new Function(files["app.js"]);
    } catch {
      findings.push("Artifact app.js must be parseable JavaScript.");
    }
  }

  if (typeof files["styles.css"] === "string") {
    let blockDepth = 0;
    for (const character of files["styles.css"]) {
      if (character === "{") blockDepth += 1;
      if (character === "}") blockDepth -= 1;
      if (blockDepth < 0) {
        break;
      }
    }
    if (blockDepth !== 0) {
      findings.push("Artifact styles.css must have balanced blocks.");
    }
  }

  if (findings.length > 0) {
    reject(findings.join(" "));
  }

  return {
    "index.html": files["index.html"] as string,
    "styles.css": files["styles.css"] as string,
    "app.js": files["app.js"] as string,
    "manifest.json": files["manifest.json"] as string,
  };
}
