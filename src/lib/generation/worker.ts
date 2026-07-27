import { deepSeekProvider } from "@/lib/generation/deepseek";
import { applyArtifactRepair } from "@/lib/generation/patch";
import {
  deterministicProvider,
  type GenerationProvider,
} from "@/lib/generation/provider";
import {
  claimGenerationStep,
  completeGenerationJob,
  failGenerationJob,
  getGenerationStepInput,
  MAX_GENERATION_ATTEMPTS,
  persistGenerationAttempt,
  updateGenerationStatus,
} from "@/lib/generation/repository";
import {
  ARTIFACT_FILES,
  type ArtifactFiles,
  type ArtifactRepairPatch,
  type GenerationInput,
} from "@/lib/generation/types";
import {
  getValidationDiagnostic,
  validateArtifact,
} from "@/lib/generation/validator";

const runningJobs = new Set<string>();
const UNCHANGED_REPAIR_FINDING =
  "The previous Incremental Repair did not change any Candidate Artifact file. Replace at least one file with changed complete content that directly fixes the finding.";

function supportsConstrainedFallback(buildRequest: string): boolean {
  return /programmer calculator|程序员计算器/i.test(buildRequest);
}

function getConfiguredProvider(): GenerationProvider {
  return process.env.GENERATION_PROVIDER === "deterministic"
    ? deterministicProvider
    : deepSeekProvider;
}

function readCandidate(input: unknown): ArtifactFiles | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if (
    Object.keys(record).length !== ARTIFACT_FILES.length ||
    !ARTIFACT_FILES.every(
      (path) =>
        typeof record[path] === "string" &&
        (record[path] as string).length <= 40_000,
    )
  ) {
    return null;
  }
  return Object.fromEntries(
    ARTIFACT_FILES.map((path) => [path, record[path]]),
  ) as ArtifactFiles;
}

function artifactsEqual(left: ArtifactFiles, right: ArtifactFiles): boolean {
  return ARTIFACT_FILES.every((path) => left[path] === right[path]);
}

async function completeFallback(
  jobId: string,
  projectId: string,
  input: GenerationInput,
  expectedStatus: "generating" | "validating",
): Promise<boolean> {
  if (!supportsConstrainedFallback(input.buildRequest)) return false;
  const files = validateArtifact(await deterministicProvider.generate(input));
  if (
    !(await updateGenerationStatus(
      jobId,
      expectedStatus,
      "validating",
      "AI attempts exhausted. Validating the constrained calculator template.",
    ))
  ) {
    return true;
  }
  await completeGenerationJob(jobId, projectId, files);
  return true;
}

async function persistProviderFailure(
  jobId: string,
  projectId: string,
  input: GenerationInput,
  attemptCount: number,
  kind: "generate" | "repair",
  candidate: ArtifactFiles | null,
  error: unknown,
): Promise<void> {
  if (
    attemptCount + 1 >= MAX_GENERATION_ATTEMPTS &&
    (await completeFallback(jobId, projectId, input, "generating"))
  ) {
    return;
  }
  const providerError =
    error instanceof Error && /^provider_[a-z0-9_]+$/i.test(error.message)
      ? error.message
      : "provider_invalid_response";
  await persistGenerationAttempt({
    candidateFiles: candidate ?? undefined,
    expectedStatus: "generating",
    jobId,
    kind,
    outcome: "provider_failed",
    providerError,
  });
}

export async function runGenerationJob(
  jobId: string,
  provider: GenerationProvider = getConfiguredProvider(),
): Promise<void> {
  if (runningJobs.has(jobId)) return;

  runningJobs.add(jobId);
  try {
    const claim = await claimGenerationStep(jobId);
    if (!claim) return;

    const step = await getGenerationStepInput(jobId);
    if (
      claim.requiresGenerateTransition &&
      !(await updateGenerationStatus(
        jobId,
        "planning",
        "generating",
        "Generating one persisted Candidate Artifact.",
      ))
    ) {
      return;
    }

    let candidate: ArtifactFiles;
    let repairPatch: ArtifactRepairPatch | undefined;
    if (claim.mode === "revalidate") {
      if (!step.candidate) {
        await failGenerationJob(jobId, "artifact_invalid");
        return;
      }
      candidate = step.candidate;
    } else {
      try {
        if (claim.mode === "repair") {
          if (!step.candidate || !provider.repair) {
            throw new Error("provider_unavailable");
          }
          const response = await provider.repair(
            step.input,
            step.candidate,
            step.diagnostic ?? "Continue improving the constrained artifact.",
          );
          const repaired = applyArtifactRepair(step.candidate, response);
          if (artifactsEqual(step.candidate, repaired.files)) {
            const diagnostic = [
              step.diagnostic ?? "The Candidate Artifact still fails validation.",
              UNCHANGED_REPAIR_FINDING,
            ].join(" ");
            if (
              step.attemptCount + 1 >= MAX_GENERATION_ATTEMPTS &&
              (await completeFallback(
                jobId,
                claim.projectId,
                step.input,
                "generating",
              ))
            ) {
              return;
            }
            await persistGenerationAttempt({
              candidateFiles: step.candidate,
              diagnostic,
              expectedStatus: "generating",
              jobId,
              kind: "repair",
              outcome: "rejected",
              repairPatch: repaired.patch,
            });
            return;
          }
          candidate = repaired.files;
          repairPatch = repaired.patch;
        } else {
          const response = await provider.generate(step.input);
          const generated = readCandidate(response);
          if (!generated) throw new Error("provider_invalid_response");
          candidate = generated;
        }
      } catch (error) {
        await persistProviderFailure(
          jobId,
          claim.projectId,
          step.input,
          step.attemptCount,
          claim.mode,
          step.candidate,
          error,
        );
        return;
      }
    }

    if (
      claim.mode !== "revalidate" &&
      !(await updateGenerationStatus(
        jobId,
        "generating",
        "validating",
        claim.mode === "repair"
          ? "Validating the incrementally repaired full candidate."
          : "Validating the exact artifact contract.",
      ))
    ) {
      return;
    }

    try {
      const files = validateArtifact(candidate);
      await completeGenerationJob(jobId, claim.projectId, files);
    } catch (error) {
      const diagnostic = getValidationDiagnostic(error);
      if (
        step.attemptCount + 1 >= MAX_GENERATION_ATTEMPTS &&
        (await completeFallback(
          jobId,
          claim.projectId,
          step.input,
          "validating",
        ))
      ) {
        return;
      }
      await persistGenerationAttempt({
        candidateFiles: candidate,
        diagnostic,
        expectedStatus: "validating",
        jobId,
        kind: claim.mode === "generate" ? "generate" : "repair",
        outcome: "rejected",
        repairPatch,
      });
    }
  } catch (error) {
    const message =
      error instanceof Error && /^provider_[a-z0-9_]+$/i.test(error.message)
        ? error.message
        : "generation_failed";
    await failGenerationJob(jobId, message);
  } finally {
    runningJobs.delete(jobId);
  }
}
