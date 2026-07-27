import { isUiPresetName, type UiPresetName } from "@/lib/generation/ui-presets";

export type ArtifactManifest = {
  entry: "index.html";
  smoke: {
    action: "click";
    expect: { selector: string; text: string };
    selector: string;
  };
  ui: { preset: UiPresetName };
};

export function parseArtifactManifest(value: unknown): ArtifactManifest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const manifest = value as Record<string, unknown>;
  if (manifest.entry !== "index.html") return null;
  const ui = manifest.ui && typeof manifest.ui === "object" && !Array.isArray(manifest.ui)
    ? manifest.ui as Record<string, unknown>
    : null;
  if (!ui) return null;
  if (!isUiPresetName(ui.preset) || Object.keys(ui).some((key) => key !== "preset")) return null;
  if (!manifest.smoke || typeof manifest.smoke !== "object" || Array.isArray(manifest.smoke)) return null;
  const smoke = manifest.smoke as Record<string, unknown>;
  if (smoke.action !== "click" || typeof smoke.selector !== "string") return null;
  if (!smoke.expect || typeof smoke.expect !== "object" || Array.isArray(smoke.expect)) return null;
  const expect = smoke.expect as Record<string, unknown>;
  if (typeof expect.selector !== "string" || typeof expect.text !== "string") return null;
  return {
    entry: "index.html",
    smoke: {
      action: "click",
      expect: { selector: expect.selector, text: expect.text },
      selector: smoke.selector,
    },
    ui: { preset: ui.preset },
  };
}

export function readArtifactManifest(source: string): ArtifactManifest | null {
  try {
    return parseArtifactManifest(JSON.parse(source));
  } catch {
    return null;
  }
}
