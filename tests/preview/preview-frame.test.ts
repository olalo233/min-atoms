import { describe, expect, it, vi } from "vitest";

import {
  arePreviewFramePropsEqual,
  type PreviewFrameProps,
} from "@/components/preview/preview-frame";

const files = {
  "app.js": "document.body.textContent = 'ready';",
  "index.html": "<main></main>",
  "manifest.json": JSON.stringify({
    entry: "index.html",
    ui: { preset: "min-atoms-base" },
  }),
  "styles.css": "",
};

const runtimeRepairQueued = vi.fn();

function previewProps(
  overrides: Partial<PreviewFrameProps> = {},
): PreviewFrameProps {
  return {
    artifactVersionId: "version-1",
    files,
    onRuntimeRepairQueued: runtimeRepairQueued,
    projectId: "project-1",
    ...overrides,
  };
}

describe("arePreviewFramePropsEqual", () => {
  it("keeps an immutable Artifact Version mounted through polling snapshots", () => {
    expect(
      arePreviewFramePropsEqual(
        previewProps(),
        previewProps({ files: { ...files } }),
      ),
    ).toBe(true);
  });

  it("remounts when identity or runtime-report behavior changes", () => {
    expect(
      arePreviewFramePropsEqual(
        previewProps(),
        previewProps({ artifactVersionId: "version-2" }),
      ),
    ).toBe(false);
    expect(
      arePreviewFramePropsEqual(
        previewProps(),
        previewProps({ projectId: "project-2" }),
      ),
    ).toBe(false);
    expect(
      arePreviewFramePropsEqual(
        previewProps(),
        previewProps({ onRuntimeRepairQueued: vi.fn() }),
      ),
    ).toBe(false);
  });
});
