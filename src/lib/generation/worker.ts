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
    try {
      await validateArtifactSmoke(validateArtifact(files));
    } catch (error) {
      const diagnostic = getValidationDiagnostic(error);
      if (!provider.repair) {
        throw new Error("artifact_invalid");
      }
      if (!(await updateGenerationStatus(
        jobId,
        "validating",
        "repairing",
        "Repairing one validation finding.",
      ))) {
        return;
      }
      files = await provider.repair(input, files, diagnostic);
      if (!(await updateGenerationStatus(
        jobId,
        "repairing",
        "validating",
        "Validating the repaired artifact.",
      ))) {
        return;
      }
      try {
        await validateArtifactSmoke(validateArtifact(files));
      } catch {
        throw new Error("artifact_invalid");
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
    await failGenerationJob(jobId, message);
  } finally {
    runningJobs.delete(jobId);
  }
}
