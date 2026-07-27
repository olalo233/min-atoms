export const UI_PRESET_NAMES = [
  "min-atoms-base",
  "pico-2",
  "bootstrap-5",
] as const;

export type UiPresetName = (typeof UI_PRESET_NAMES)[number];

type ExternalStylesheet = {
  crossOrigin: "anonymous";
  integrity?: string;
  url: string;
};

export type UiPreset = {
  description: string;
  stylesheet: ExternalStylesheet | null;
};

export const UI_PRESETS: Record<UiPresetName, UiPreset> = {
  "min-atoms-base": {
    description: "A dependency-free base for bespoke and editorial interfaces.",
    stylesheet: null,
  },
  "pico-2": {
    description: "Semantic, lightweight styling for tools, forms, and content applications.",
    stylesheet: {
      crossOrigin: "anonymous",
      url: "https://cdn.jsdelivr.net/npm/@picocss/pico@2.1.1/css/pico.min.css",
    },
  },
  "bootstrap-5": {
    description: "A broad responsive component and utility system for dashboards and data-heavy applications.",
    stylesheet: {
      crossOrigin: "anonymous",
      integrity: "sha384-QWTKZyjpPEjISv5WaRU9OFeRpok6YctnYmDr5pNlyT2bRjXh0JMhjY6hW+ALEwIH",
      url: "https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css",
    },
  },
};

export function isUiPresetName(value: unknown): value is UiPresetName {
  return typeof value === "string" && UI_PRESET_NAMES.includes(value as UiPresetName);
}
