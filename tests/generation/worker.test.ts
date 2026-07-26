import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GenerationProvider } from "@/lib/generation/provider";

const repository = vi.hoisted(() => ({
  claimGenerationJob: vi.fn(),
  completeGenerationJob: vi.fn(),
  failGenerationJob: vi.fn(),
  getGenerationInputForJob: vi.fn(),
  getGenerationSnapshotForJob: vi.fn(),
  updateGenerationStatus: vi.fn(),
}));
const smoke = vi.hoisted(() => ({
  validateArtifactSmoke: vi.fn(),
}));

vi.mock("@/lib/generation/repository", () => repository);
vi.mock("@/lib/generation/smoke", () => smoke);

import { runGenerationJob } from "@/lib/generation/worker";

const files = {
  "app.js": "",
  "index.html": '<button id="trigger">Try it</button><output id="result"></output>',
  "manifest.json": JSON.stringify({
    entry: "index.html",
    smoke: {
      action: "click",
      expect: { selector: "#result", text: "ready" },
      selector: "#trigger",
    },
  }),
  "styles.css": "",
};

describe("generation worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repository.updateGenerationStatus.mockResolvedValue(true);
    smoke.validateArtifactSmoke.mockResolvedValue(undefined);
  });

  it("claims one queued job and uses its persisted Build Request", async () => {
    repository.claimGenerationJob.mockResolvedValue(true);
    repository.getGenerationSnapshotForJob.mockResolvedValue({
      artifactVersion: null,
      events: [],
      job: {
        buildRequestId: "request-1",
        completedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        errorMessage: null,
        id: "job-1",
        projectId: "project-1",
        status: "planning",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    repository.getGenerationInputForJob.mockResolvedValue({
      baseArtifact: null,
      buildRequest: "Build a counter",
    });
    const provider: GenerationProvider = {
      generate: vi.fn().mockResolvedValue(files),
    };

    await runGenerationJob("job-1", provider);

    expect(repository.claimGenerationJob).toHaveBeenCalledWith("job-1");
    expect(repository.getGenerationInputForJob).toHaveBeenCalledWith("job-1");
    expect(provider.generate).toHaveBeenCalledWith({
      baseArtifact: null,
      buildRequest: "Build a counter",
    });
    expect(repository.updateGenerationStatus.mock.calls).toEqual([
      [
        "job-1",
        "planning",
        "generating",
        "Generating the constrained four-file artifact.",
      ],
      [
        "job-1",
        "generating",
        "validating",
        "Validating the exact artifact contract.",
      ],
    ]);
    expect(repository.completeGenerationJob).toHaveBeenCalledWith(
      "job-1",
      "project-1",
      files,
    );
    expect(repository.failGenerationJob).not.toHaveBeenCalled();
  });

  it("does not run a provider when another worker already claimed the job", async () => {
    repository.claimGenerationJob.mockResolvedValue(false);
    const provider: GenerationProvider = {
      generate: vi.fn(),
    };

    await runGenerationJob("job-2", provider);

    expect(provider.generate).not.toHaveBeenCalled();
    expect(repository.getGenerationSnapshotForJob).not.toHaveBeenCalled();
  });

  it("stops without completing when a persisted cancellation wins", async () => {
    repository.claimGenerationJob.mockResolvedValue(true);
    repository.getGenerationSnapshotForJob.mockResolvedValue({
      artifactVersion: null,
      events: [],
      job: {
        buildRequestId: "request-cancelled",
        completedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        errorMessage: null,
        id: "job-cancelled",
        projectId: "project-cancelled",
        status: "planning",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    repository.getGenerationInputForJob.mockResolvedValue({
      baseArtifact: null,
      buildRequest: "Build a counter",
    });
    repository.updateGenerationStatus.mockResolvedValueOnce(false);
    const provider: GenerationProvider = {
      generate: vi.fn(),
    };

    await runGenerationJob("job-cancelled", provider);

    expect(provider.generate).not.toHaveBeenCalled();
    expect(repository.completeGenerationJob).not.toHaveBeenCalled();
    expect(repository.failGenerationJob).not.toHaveBeenCalled();
  });

  it("repairs one rejected artifact and completes the same job", async () => {
    repository.claimGenerationJob.mockResolvedValue(true);
    repository.getGenerationSnapshotForJob.mockResolvedValue({
      artifactVersion: null,
      events: [],
      job: {
        buildRequestId: "request-3",
        completedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        errorMessage: null,
        id: "job-3",
        projectId: "project-3",
        status: "planning",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    repository.getGenerationInputForJob.mockResolvedValue({
      baseArtifact: null,
      buildRequest: "Build a counter",
    });
    const repairable = { ...files, "manifest.json": "{}" };
    const provider: GenerationProvider = {
      generate: vi.fn().mockResolvedValue(repairable),
      repair: vi.fn().mockResolvedValue(files),
    };

    await runGenerationJob("job-3", provider);

    expect(provider.repair).toHaveBeenCalledWith(
      { baseArtifact: null, buildRequest: "Build a counter" },
      repairable,
      "Artifact manifest must point to index.html.",
    );
    expect(repository.updateGenerationStatus.mock.calls).toEqual([
      ["job-3", "planning", "generating", "Generating the constrained four-file artifact."],
      ["job-3", "generating", "validating", "Validating the exact artifact contract."],
      ["job-3", "validating", "repairing", "Repairing validation finding 1 of 2."],
      ["job-3", "repairing", "validating", "Validating the repaired artifact."],
    ]);
    expect(repository.completeGenerationJob).toHaveBeenCalledWith(
      "job-3",
      "project-3",
      files,
    );
    expect(repository.failGenerationJob).not.toHaveBeenCalled();
  });

  it("uses the second validation finding for one final bounded repair", async () => {
    repository.claimGenerationJob.mockResolvedValue(true);
    repository.getGenerationSnapshotForJob.mockResolvedValue({
      artifactVersion: null,
      events: [],
      job: {
        buildRequestId: "request-3b",
        completedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        errorMessage: null,
        id: "job-3b",
        projectId: "project-3b",
        status: "planning",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    repository.getGenerationInputForJob.mockResolvedValue({
      baseArtifact: null,
      buildRequest: "Render Markdown without external libraries",
    });
    const first = { ...files, "manifest.json": "{}" };
    const second = { ...files, "app.js": "marked.parse('hello')" };
    const provider: GenerationProvider = {
      generate: vi.fn().mockResolvedValue(first),
      repair: vi.fn()
        .mockResolvedValueOnce(second)
        .mockResolvedValueOnce(files),
    };
    smoke.validateArtifactSmoke
      .mockRejectedValueOnce(new Error("undeclared runtime global"))
      .mockResolvedValueOnce(undefined);

    await runGenerationJob("job-3b", provider);

    expect(provider.repair).toHaveBeenNthCalledWith(
      1,
      {
        baseArtifact: null,
        buildRequest: "Render Markdown without external libraries",
      },
      first,
      "Artifact manifest must point to index.html.",
    );
    expect(provider.repair).toHaveBeenNthCalledWith(
      2,
      {
        baseArtifact: null,
        buildRequest: "Render Markdown without external libraries",
      },
      second,
      "Artifact did not satisfy the required contract.",
    );
    expect(repository.completeGenerationJob).toHaveBeenCalledWith(
      "job-3b",
      "project-3b",
      files,
    );
    expect(repository.failGenerationJob).not.toHaveBeenCalled();
  });

  it("fails safely after two permanently invalid repairs without replacing an artifact", async () => {
    repository.claimGenerationJob.mockResolvedValue(true);
    repository.getGenerationSnapshotForJob.mockResolvedValue({
      artifactVersion: null,
      events: [],
      job: {
        buildRequestId: "request-4",
        completedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        errorMessage: null,
        id: "job-4",
        projectId: "project-4",
        status: "planning",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    repository.getGenerationInputForJob.mockResolvedValue({
      baseArtifact: null,
      buildRequest: "Build a counter",
    });
    const invalid = { ...files, "manifest.json": "{}" };
    const provider: GenerationProvider = {
      generate: vi.fn().mockResolvedValue(invalid),
      repair: vi.fn().mockResolvedValue(invalid),
    };

    await runGenerationJob("job-4", provider);

    expect(provider.repair).toHaveBeenCalledWith(
      { baseArtifact: null, buildRequest: "Build a counter" },
      invalid,
      "Artifact manifest must point to index.html.",
    );
    expect(repository.completeGenerationJob).not.toHaveBeenCalled();
    expect(repository.failGenerationJob).toHaveBeenCalledWith(
      "job-4",
      "artifact_invalid",
    );
    expect(provider.repair).toHaveBeenCalledTimes(2);
    expect(repository.updateGenerationStatus).toHaveBeenCalledTimes(6);
  });
});
