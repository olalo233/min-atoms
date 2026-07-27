import { isUiPresetName, type UiPresetName } from "@/lib/generation/ui-presets";

export type ArtifactManifest = {
  entry: "index.html";
  smoke: {
    actions: Array<{
      action: "click";
      selector: string;
    }>;
    expect: { selector: string; text: string };
  };
  ui: { preset: UiPresetName };
};

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function parseSmokeActions(
  smoke: Record<string, unknown>,
): ArtifactManifest["smoke"]["actions"] | null {
  if (
    hasExactKeys(smoke, ["action", "expect", "selector"]) &&
    smoke.action === "click" &&
    typeof smoke.selector === "string"
  ) {
    return [{ action: "click", selector: smoke.selector }];
  }
  if (
    !hasExactKeys(smoke, ["actions", "expect"]) ||
    !Array.isArray(smoke.actions) ||
    smoke.actions.length < 1 ||
    smoke.actions.length > 8
  ) {
    return null;
  }
  const actions: ArtifactManifest["smoke"]["actions"] = [];
  for (const value of smoke.actions) {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !hasExactKeys(value as Record<string, unknown>, ["action", "selector"])
    ) {
      return null;
    }
    const action = value as Record<string, unknown>;
    if (action.action !== "click" || typeof action.selector !== "string") {
      return null;
    }
    actions.push({ action: "click", selector: action.selector });
  }
  return actions;
}

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
  const actions = parseSmokeActions(smoke);
  if (!actions) return null;
  if (!smoke.expect || typeof smoke.expect !== "object" || Array.isArray(smoke.expect)) return null;
  const expect = smoke.expect as Record<string, unknown>;
  if (
    !hasExactKeys(expect, ["selector", "text"]) ||
    typeof expect.selector !== "string" ||
    typeof expect.text !== "string"
  ) return null;
  return {
    entry: "index.html",
    smoke: {
      actions,
      expect: { selector: expect.selector, text: expect.text },
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
