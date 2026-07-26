// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GenerationPanel } from "@/components/projects/generation-panel";
import type { GenerationSnapshot } from "@/lib/generation/types";

vi.mock("@/components/preview/preview-frame", () => ({
  PreviewFrame: ({ artifactVersionId }: { artifactVersionId: string }) => <div data-testid="preview-frame">Interactive preview {artifactVersionId}</div>,
}));

const artifactFiles = {
  "app.js": "",
  "index.html": "<button>Increment</button>",
  "manifest.json": "{}",
  "styles.css": "",
};

function generationSnapshot(
  status: string | null,
  options: {
    artifact?: boolean;
    errorMessage?: string | null;
    events?: GenerationSnapshot["events"];
  } = {},
): GenerationSnapshot {
  return {
    artifactVersion: options.artifact
      ? {
          createdAt: "2026-07-26T00:00:00.000Z",
          files: artifactFiles,
          id: "version-1",
          version: 1,
        }
      : null,
    events: options.events ?? [],
    job: status
      ? {
          buildRequestId: "request-1",
          baseVersionId: null,
          completedAt: status === "completed" ? "2026-07-26T00:01:00.000Z" : null,
          createdAt: "2026-07-26T00:00:00.000Z",
          errorMessage: options.errorMessage ?? null,
          id: "job-1",
          projectId: "project-1",
          status,
          updatedAt: "2026-07-26T00:01:00.000Z",
        }
      : null,
    versions: options.artifact
      ? [{ createdAt: "2026-07-26T00:00:00.000Z", id: "version-1", version: 1 }]
      : [],
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
});

describe("GenerationPanel", () => {
  it("makes the empty-state generation action and honest waiting Preview clear", () => {
    render(
      <GenerationPanel
        buildRequest="Build a focused interval timer."
        initialGeneration={generationSnapshot(null)}
        projectId="project-1"
      />,
    );

    expect(screen.getByRole("button", { name: "Generate first version" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Awaiting generation");
    expect(screen.getByText("Build a focused interval timer.")).toBeVisible();
    expect(screen.queryByTestId("preview-frame")).not.toBeInTheDocument();
  });

  it("uses the existing generation POST as an accessible retry after failure", async () => {
    const queuedSnapshot = generationSnapshot("queued", {
      events: [
        {
          createdAt: "2026-07-26T00:00:00.000Z",
          id: "event-2",
          message: "Generation queued.",
          sequence: 1,
          stage: "queued",
        },
      ],
    });
    const fetchMock = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue(queuedSnapshot),
      ok: true,
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <GenerationPanel
        buildRequest="Build a compact counter."
        initialGeneration={generationSnapshot("failed", {
          errorMessage: "Artifact validation failed.",
        })}
        projectId="project-1"
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Artifact validation failed.");
    fireEvent.click(screen.getByRole("button", { name: "Retry generation" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/projects/project-1/generation",
        { method: "POST" },
      );
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Queued");
  });

  it("explains cancellation and requeues the unchanged request", async () => {
    const queuedSnapshot = generationSnapshot("queued", {
      events: [
        {
          createdAt: "2026-07-26T00:00:00.000Z",
          id: "event-2",
          message: "Generation queued.",
          sequence: 1,
          stage: "queued",
        },
      ],
    });
    const fetchMock = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue(queuedSnapshot),
      ok: true,
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <GenerationPanel
        buildRequest="Build a compact counter."
        initialGeneration={generationSnapshot("cancelled", {
          events: [
            {
              createdAt: "2026-07-26T00:00:00.000Z",
              id: "event-cancelled",
              message: "Generation cancelled.",
              sequence: 2,
              stage: "cancelled",
            },
          ],
        })}
        projectId="project-1"
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Generation cancelled");
    expect(screen.getByRole("alert")).toHaveTextContent("requeue the unchanged Build Request");
    fireEvent.click(screen.getByRole("button", { name: "Requeue generation" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/projects/project-1/generation",
        { method: "POST" },
      );
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Queued");
  });

  it("distinguishes repair from success and only exposes accepted Preview output", () => {
    const { unmount } = render(
      <GenerationPanel
        buildRequest="Build a compact counter."
        initialGeneration={generationSnapshot("repairing", {
          events: [
            {
              createdAt: "2026-07-26T00:00:30.000Z",
              id: "event-4",
              message: "Repairing a bounded validation issue.",
              sequence: 4,
              stage: "repairing",
            },
          ],
        })}
        projectId="project-1"
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Repairing");
    expect(screen.queryByTestId("preview-frame")).not.toBeInTheDocument();

    unmount();
    render(
      <GenerationPanel
        buildRequest="Build a compact counter."
        initialGeneration={generationSnapshot("completed", {
          artifact: true,
          events: [
            {
              createdAt: "2026-07-26T00:01:00.000Z",
              id: "event-5",
              message: "Version 1 is ready in Preview.",
              sequence: 5,
              stage: "completed",
            },
          ],
        })}
        projectId="project-1"
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Preview ready");
    expect(screen.getByTestId("preview-frame")).toBeVisible();
    expect(screen.queryByRole("button", { name: /generation/i })).not.toBeInTheDocument();
  });

  it("switches the inspected version without mutation and restores only when asked", async () => {
    const v1 = { createdAt: "2026-07-26T00:00:00.000Z", files: artifactFiles, id: "version-1", version: 1 };
    const v2 = { createdAt: "2026-07-26T00:01:00.000Z", files: artifactFiles, id: "version-2", version: 2 };
    const activeV1 = { ...generationSnapshot("completed", { artifact: true }), artifactVersion: v1, versions: [v2, v1] };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue({ artifactVersion: v1 }), ok: true })
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue(activeV1), ok: true });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <GenerationPanel
        buildRequest="Build a compact counter."
        initialGeneration={{ ...generationSnapshot("completed", { artifact: true }), artifactVersion: v2, versions: [v2, v1] }}
        projectId="project-1"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "v1" }));
    await screen.findByRole("button", { name: "Restore v1 as active" });
    expect(screen.getByTestId("preview-frame")).toHaveTextContent("version-1");
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/project-1/versions/version-1", { cache: "no-store" });

    fireEvent.click(screen.getByRole("button", { name: "Restore v1 as active" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/projects/project-1/versions/version-1/restore",
        { method: "POST" },
      );
    });
  });

  it("displays a completed follow-up as the new active Artifact Version", async () => {
    vi.useFakeTimers();
    const v1 = { createdAt: "2026-07-26T00:00:00.000Z", files: artifactFiles, id: "version-1", version: 1 };
    const v2 = { createdAt: "2026-07-26T00:01:00.000Z", files: artifactFiles, id: "version-2", version: 2 };
    const completed = {
      ...generationSnapshot("completed", { artifact: true }),
      artifactVersion: v2,
      versions: [v2, v1],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue(completed), ok: true }));

    render(
      <GenerationPanel
        buildRequest="Build a compact counter."
        initialGeneration={{ ...generationSnapshot("generating", { artifact: true }), artifactVersion: v1, versions: [v1] }}
        projectId="project-1"
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(screen.getByTestId("preview-frame")).toHaveTextContent("version-2");
    expect(screen.getByText("Artifact Version 2")).toBeVisible();
  });

  it("pauses progress polling while the tab is hidden and resumes on return", async () => {
    vi.useFakeTimers();
    const completedSnapshot = generationSnapshot("completed", { artifact: true });
    const fetchMock = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue(completedSnapshot),
      ok: true,
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <GenerationPanel
        buildRequest="Build a compact counter."
        initialGeneration={generationSnapshot("generating")}
        projectId="project-1"
      />,
    );

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    await act(async () => {
      fireEvent(document, new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(fetchMock).not.toHaveBeenCalled();

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    await act(async () => {
      fireEvent(document, new Event("visibilitychange"));
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/project-1/generation", {
      cache: "no-store",
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Preview ready");
  });

  it("stops the active agent and explains the cancelled state", async () => {
    const cancelledSnapshot = generationSnapshot("cancelled", {
      events: [
        {
          createdAt: "2026-07-26T00:01:00.000Z",
          id: "event-cancelled",
          message: "Generation cancelled.",
          sequence: 2,
          stage: "cancelled",
        },
      ],
    });
    const fetchMock = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue(cancelledSnapshot),
      ok: true,
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <GenerationPanel
        buildRequest="Build a compact counter."
        initialGeneration={generationSnapshot("generating", {
          events: [
            {
              createdAt: "2026-07-26T00:00:30.000Z",
              id: "event-3",
              message: "Generating the artifact files.",
              sequence: 1,
              stage: "generating",
            },
          ],
        })}
        projectId="project-1"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Stop agent" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/projects/project-1/generation",
        { method: "DELETE" },
      );
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Generation cancelled");
    expect(screen.queryByRole("button", { name: "Stop agent" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Requeue generation" })).toBeVisible();
  });

  it("keeps the stop control hidden once the preview is ready", () => {
    render(
      <GenerationPanel
        buildRequest="Build a compact counter."
        initialGeneration={generationSnapshot("completed", { artifact: true })}
        projectId="project-1"
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Preview ready");
    expect(screen.queryByRole("button", { name: "Stop agent" })).not.toBeInTheDocument();
  });

  it("surfaces an honest error when the agent cannot be stopped", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({ error: "Project not found." }),
      ok: false,
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <GenerationPanel
        buildRequest="Build a compact counter."
        initialGeneration={generationSnapshot("generating")}
        projectId="project-1"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Stop agent" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Project not found.");
    expect(screen.getByRole("status")).toHaveTextContent("Generating");
  });
});
