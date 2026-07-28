// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PreviewFrame,
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  runtimeRepairQueued.mockReset();
});

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

describe("PreviewFrame reload-loop containment", () => {
  it("replaces a repeatedly loaded document with a stable repair state", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({
        artifactVersion: null,
        events: [],
        job: { status: "repairing" },
        versions: [],
      }),
      ok: true,
      status: 202,
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<PreviewFrame {...previewProps()} />);
    const frame = screen.getByTitle("Interactive generated preview");

    fireEvent.load(frame);
    fireEvent.load(frame);

    expect(
      screen.getByRole("status", { name: "Preview reload stopped" }),
    ).toBeVisible();
    expect(
      screen.queryByTitle("Interactive generated preview"),
    ).not.toBeInTheDocument();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByText("The Agent is repairing a reload loop."),
    ).toBeVisible();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      kind: "reload_loop",
    });
  });

  it("shows a truthful retry path when the repair request fails", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({
        json: async () => ({
          artifactVersion: null,
          events: [],
          job: { status: "repairing" },
          versions: [],
        }),
        ok: true,
        status: 202,
      });
    vi.stubGlobal("fetch", fetchMock);

    render(<PreviewFrame {...previewProps()} />);
    const frame = screen.getByTitle("Interactive generated preview");
    fireEvent.load(frame);
    fireEvent.load(frame);

    expect(
      await screen.findByText("The repair request could not be sent."),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry repair" }));

    expect(
      await screen.findByText("The Agent is repairing a reload loop."),
    ).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not claim repair when the API accepts the report without queuing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: async () => ({
          artifactVersion: null,
          events: [],
          job: { status: "completed" },
          versions: [],
        }),
        ok: true,
        status: 200,
      }),
    );

    render(<PreviewFrame {...previewProps()} />);
    const frame = screen.getByTitle("Interactive generated preview");
    fireEvent.load(frame);
    fireEvent.load(frame);

    expect(
      await screen.findByText(
        "The reload was stopped, but no new repair was queued.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByText("The Agent is repairing a reload loop."),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Retry repair" }),
    ).toBeVisible();
  });
});
