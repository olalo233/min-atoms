import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GenerationProvider } from "@/lib/generation/provider";

const repository = vi.hoisted(() => ({
  claimGenerationStep: vi.fn(),
  completeGenerationJob: vi.fn(),
  failGenerationJob: vi.fn(),
  getGenerationStepInput: vi.fn(),
  persistGenerationAttempt: vi.fn(),
  updateGenerationStatus: vi.fn(),
}));
const smoke = vi.hoisted(() => ({
  validateArtifactSmoke: vi.fn(),
}));

vi.mock("@/lib/generation/repository", () => ({
  ...repository,
  MAX_GENERATION_ATTEMPTS: 10,
}));
vi.mock("@/lib/generation/smoke", () => smoke);

import { runGenerationJob } from "@/lib/generation/worker";

const files = {
  "app.js": "",
  "index.html": '<button id="trigger">Try it</button><output id="result"></output>',
  "manifest.json": JSON.stringify({
    entry: "index.html",
    ui: { preset: "min-atoms-base" },
    smoke: {
      action: "click",
      expect: { selector: "#result", text: "ready" },
      selector: "#trigger",
    },
  }),
  "styles.css": "",
};

describe("durable generation worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repository.updateGenerationStatus.mockResolvedValue(true);
    repository.persistGenerationAttempt.mockResolvedValue("repairing");
    smoke.validateArtifactSmoke.mockResolvedValue(undefined);
  });

  it("performs one generation request and completes a valid candidate", async () => {
    repository.claimGenerationStep.mockResolvedValue({
      mode: "generate",
      projectId: "project-1",
      requiresGenerateTransition: true,
    });
    repository.getGenerationStepInput.mockResolvedValue({
      attemptCount: 0,
      candidate: null,
      diagnostic: null,
      input: { baseArtifact: null, buildRequest: "Build a counter" },
    });
    const provider: GenerationProvider = {
      generate: vi.fn().mockResolvedValue(files),
      repair: vi.fn(),
    };

    await runGenerationJob("job-1", provider);

    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(provider.repair).not.toHaveBeenCalled();
    expect(repository.completeGenerationJob).toHaveBeenCalledWith(
      "job-1",
      "project-1",
      files,
    );
    expect(repository.persistGenerationAttempt).not.toHaveBeenCalled();
  });

  it("revalidates a persisted failed candidate without another provider call", async () => {
    repository.claimGenerationStep.mockResolvedValue({
      mode: "revalidate",
      projectId: "project-revalidate",
      requiresGenerateTransition: false,
    });
    repository.getGenerationStepInput.mockResolvedValue({
      attemptCount: 10,
      candidate: files,
      diagnostic: "Artifact file index.html uses a forbidden capability.",
      input: { baseArtifact: null, buildRequest: "Build a blog" },
    });
    const provider: GenerationProvider = {
      generate: vi.fn(),
      repair: vi.fn(),
    };

    await runGenerationJob("job-revalidate", provider);

    expect(provider.generate).not.toHaveBeenCalled();
    expect(provider.repair).not.toHaveBeenCalled();
    expect(repository.updateGenerationStatus).not.toHaveBeenCalled();
    expect(repository.completeGenerationJob).toHaveBeenCalledWith(
      "job-revalidate",
      "project-revalidate",
      files,
    );
  });

  it("persists an invalid candidate and stops without repairing in the same invocation", async () => {
    const invalid = { ...files, "manifest.json": "{}" };
    repository.claimGenerationStep.mockResolvedValue({
      mode: "generate",
      projectId: "project-2",
      requiresGenerateTransition: true,
    });
    repository.getGenerationStepInput.mockResolvedValue({
      attemptCount: 0,
      candidate: null,
      diagnostic: null,
      input: { baseArtifact: null, buildRequest: "Build a counter" },
    });
    const provider: GenerationProvider = {
      generate: vi.fn().mockResolvedValue(invalid),
      repair: vi.fn(),
    };

    await runGenerationJob("job-2", provider);

    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(provider.repair).not.toHaveBeenCalled();
    expect(repository.persistGenerationAttempt).toHaveBeenCalledWith({
      candidateFiles: invalid,
      diagnostic: "Artifact manifest must satisfy the required contract.",
      expectedStatus: "validating",
      jobId: "job-2",
      kind: "generate",
      outcome: "rejected",
      repairPatch: undefined,
    });
    expect(repository.completeGenerationJob).not.toHaveBeenCalled();
  });

  it("resumes the persisted candidate and applies one incremental repair patch", async () => {
    const invalid = { ...files, "manifest.json": "{}" };
    repository.claimGenerationStep.mockResolvedValue({
      mode: "repair",
      projectId: "project-3",
      requiresGenerateTransition: false,
    });
    repository.getGenerationStepInput.mockResolvedValue({
      attemptCount: 1,
      candidate: invalid,
      diagnostic: "Artifact manifest must satisfy the required contract.",
      input: { baseArtifact: null, buildRequest: "Build a counter" },
    });
    const patch = {
      operations: [
        {
          content: files["manifest.json"],
          op: "replace-file" as const,
          path: "manifest.json" as const,
        },
      ],
    };
    const provider: GenerationProvider = {
      generate: vi.fn(),
      repair: vi.fn().mockResolvedValue(patch),
    };

    await runGenerationJob("job-3", provider);

    expect(provider.generate).not.toHaveBeenCalled();
    expect(provider.repair).toHaveBeenCalledTimes(1);
    expect(provider.repair).toHaveBeenCalledWith(
      { baseArtifact: null, buildRequest: "Build a counter" },
      invalid,
      "Artifact manifest must satisfy the required contract.",
    );
    expect(repository.completeGenerationJob).toHaveBeenCalledWith(
      "job-3",
      "project-3",
      files,
    );
  });

  it("persists an invalid repair response as a provider failure with the prior candidate", async () => {
    const invalid = { ...files, "manifest.json": "{}" };
    repository.claimGenerationStep.mockResolvedValue({
      mode: "repair",
      projectId: "project-4",
      requiresGenerateTransition: false,
    });
    repository.getGenerationStepInput.mockResolvedValue({
      attemptCount: 2,
      candidate: invalid,
      diagnostic: "Fix the manifest.",
      input: { baseArtifact: null, buildRequest: "Build a counter" },
    });
    const provider: GenerationProvider = {
      generate: vi.fn(),
      repair: vi.fn().mockResolvedValue({ operations: [] }),
    };

    await runGenerationJob("job-4", provider);

    expect(provider.repair).toHaveBeenCalledTimes(1);
    expect(repository.persistGenerationAttempt).toHaveBeenCalledWith({
      candidateFiles: invalid,
      expectedStatus: "generating",
      jobId: "job-4",
      kind: "repair",
      outcome: "provider_failed",
      providerError: "provider_invalid_response",
    });
    expect(repository.completeGenerationJob).not.toHaveBeenCalled();
  });

  it("persists an unchanged repair so the next invocation can fix forward", async () => {
    const invalid = { ...files, "manifest.json": "{}" };
    repository.claimGenerationStep.mockResolvedValue({
      mode: "repair",
      projectId: "project-stalled",
      requiresGenerateTransition: false,
    });
    repository.getGenerationStepInput.mockResolvedValue({
      attemptCount: 3,
      candidate: invalid,
      diagnostic: "Artifact manifest must satisfy the required contract.",
      input: { baseArtifact: null, buildRequest: "Build a blog" },
    });
    const provider: GenerationProvider = {
      generate: vi.fn(),
      repair: vi.fn().mockResolvedValue({
        operations: [
          {
            content: "{}",
            op: "replace-file",
            path: "manifest.json",
          },
        ],
      }),
    };

    await runGenerationJob("job-stalled", provider);

    expect(repository.persistGenerationAttempt).toHaveBeenCalledWith({
      candidateFiles: invalid,
      diagnostic:
        "Artifact manifest must satisfy the required contract. The previous Incremental Repair did not change any Candidate Artifact file. Replace at least one file with changed complete content that directly fixes the finding.",
      expectedStatus: "generating",
      jobId: "job-stalled",
      kind: "repair",
      outcome: "rejected",
      repairPatch: {
        operations: [
          {
            content: "{}",
            op: "replace-file",
            path: "manifest.json",
          },
        ],
      },
    });
    expect(repository.failGenerationJob).not.toHaveBeenCalled();
    expect(repository.completeGenerationJob).not.toHaveBeenCalled();
  });

  it("completes the calculator fallback when the final repair is unchanged", async () => {
    const invalid = { ...files, "manifest.json": "{}" };
    repository.claimGenerationStep.mockResolvedValue({
      mode: "repair",
      projectId: "project-calculator-fallback",
      requiresGenerateTransition: false,
    });
    repository.getGenerationStepInput.mockResolvedValue({
      attemptCount: 9,
      candidate: invalid,
      diagnostic: "The calculator smoke sequence still fails.",
      input: {
        baseArtifact: null,
        buildRequest: "生成一个功能丰富的程序员计算器",
      },
    });
    const provider: GenerationProvider = {
      generate: vi.fn(),
      repair: vi.fn().mockResolvedValue({
        operations: [
          {
            content: "{}",
            op: "replace-file",
            path: "manifest.json",
          },
        ],
      }),
    };

    await runGenerationJob("job-calculator-fallback", provider);

    expect(repository.completeGenerationJob).toHaveBeenCalledWith(
      "job-calculator-fallback",
      "project-calculator-fallback",
      expect.objectContaining({
        "app.js": expect.any(String),
        "index.html": expect.any(String),
        "manifest.json": expect.any(String),
        "styles.css": expect.any(String),
      }),
    );
    expect(repository.persistGenerationAttempt).not.toHaveBeenCalled();
    expect(repository.failGenerationJob).not.toHaveBeenCalled();
  });

  it("does not call the provider when another invocation owns the step", async () => {
    repository.claimGenerationStep.mockResolvedValue(null);
    const provider: GenerationProvider = {
      generate: vi.fn(),
      repair: vi.fn(),
    };

    await runGenerationJob("job-5", provider);

    expect(provider.generate).not.toHaveBeenCalled();
    expect(provider.repair).not.toHaveBeenCalled();
    expect(repository.getGenerationStepInput).not.toHaveBeenCalled();
  });

  it("stops when cancellation wins the persisted transition", async () => {
    repository.claimGenerationStep.mockResolvedValue({
      mode: "generate",
      projectId: "project-6",
      requiresGenerateTransition: true,
    });
    repository.getGenerationStepInput.mockResolvedValue({
      attemptCount: 0,
      candidate: null,
      diagnostic: null,
      input: { baseArtifact: null, buildRequest: "Build a counter" },
    });
    repository.updateGenerationStatus.mockResolvedValueOnce(false);
    const provider: GenerationProvider = {
      generate: vi.fn(),
    };

    await runGenerationJob("job-6", provider);

    expect(provider.generate).not.toHaveBeenCalled();
    expect(repository.completeGenerationJob).not.toHaveBeenCalled();
    expect(repository.failGenerationJob).not.toHaveBeenCalled();
  });
});
