import {
  claimGenerationJob,
  completeGenerationJob,
  failGenerationJob,
  getGenerationInputForJob,
  getGenerationSnapshotForJob,
  updateGenerationStatus,
} from "@/lib/generation/repository";
import { deepSeekProvider } from "@/lib/generation/deepseek";
import {
  deterministicProvider,
  type GenerationProvider,
} from "@/lib/generation/provider";
import {
  getValidationDiagnostic,
  validateArtifact,
} from "@/lib/generation/validator";
import { validateArtifactSmoke } from "@/lib/generation/smoke";

const runningJobs = new Set<string>();
const MAX_REPAIR_ATTEMPTS = 2;

function supportsConstrainedFallback(buildRequest: string): boolean {
  return /programmer calculator|程序员计算器/i.test(buildRequest);
}

function getConfiguredProvider(): GenerationProvider {
  return process.env.GENERATION_PROVIDER === "deterministic"
    ? deterministicProvider
    : deepSeekProvider;
}

export async function runGenerationJob(
  jobId: string,
  provider: GenerationProvider = getConfiguredProvider(),
): Promise<void> {
  if (runningJobs.has(jobId)) {
    return;
  }

  runningJobs.add(jobId);
  let failureDiagnostic: string | undefined;
  try {
    if (!(await claimGenerationJob(jobId))) {
      return;
    }

    const snapshot = await getGenerationSnapshotForJob(jobId);
    if (!snapshot.job) {
      throw new Error("Generation job not found.");
    }

    const input = await getGenerationInputForJob(jobId);
    if (!(await updateGenerationStatus(
      jobId,
      "planning",
      "generating",
      "Generating the constrained four-file artifact.",
    ))) {
      return;
    }
    let files = await provider.generate(input);

    if (!(await updateGenerationStatus(
      jobId,
      "generating",
      "validating",
      "Validating the exact artifact contract.",
    ))) {
      return;
    }
    let fallbackUsed = false;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await validateArtifactSmoke(validateArtifact(files));
        break;
      } catch (error) {
        failureDiagnostic = getValidationDiagnostic(error);
        if (!provider.repair || attempt >= MAX_REPAIR_ATTEMPTS) {
          if (
            !fallbackUsed &&
            supportsConstrainedFallback(input.buildRequest)
          ) {
            if (!(await updateGenerationStatus(
              jobId,
              "validating",
              "repairing",
              "AI repairs exhausted. Recovering with the constrained calculator template.",
            ))) {
              return;
            }
            fallbackUsed = true;
            files = await deterministicProvider.generate(input);
            if (!(await updateGenerationStatus(
              jobId,
              "repairing",
              "validating",
              "Validating the constrained calculator template.",
            ))) {
              return;
            }
            continue;
          }
          throw new Error("artifact_invalid");
        }
        if (!(await updateGenerationStatus(
          jobId,
          "validating",
          "repairing",
          `Repairing validation finding ${attempt + 1} of ${MAX_REPAIR_ATTEMPTS}.`,
        ))) {
          return;
        }
        files = await provider.repair(input, files, failureDiagnostic);
        if (!(await updateGenerationStatus(
          jobId,
          "repairing",
          "validating",
          "Validating the repaired artifact.",
        ))) {
          return;
        }
      }
    }
    await completeGenerationJob(
      jobId,
      snapshot.job.projectId,
      validateArtifact(files),
    );
  } catch (error) {
    const message = error instanceof Error && /^provider_|^artifact_invalid$/.test(error.message)
      ? error.message
      : "generation_failed";
    await failGenerationJob(
      jobId,
      message,
      message === "artifact_invalid" ? failureDiagnostic : undefined,
    );
  } finally {
    runningJobs.delete(jobId);
  }
}
