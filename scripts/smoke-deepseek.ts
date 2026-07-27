import { deepSeekProvider } from "../src/lib/generation/deepseek";
import { applyArtifactRepair } from "../src/lib/generation/patch";
import {
  ARTIFACT_FILES,
  type ArtifactFiles,
} from "../src/lib/generation/types";
import {
  getValidationDiagnostic,
  validateArtifact,
} from "../src/lib/generation/validator";
import { validateArtifactSmoke } from "../src/lib/generation/smoke";

const MAX_REPAIR_ATTEMPTS = 4;
const UNCHANGED_REPAIR_FINDING =
  "The previous Incremental Repair did not change any Candidate Artifact file. Replace at least one file with changed complete content that directly fixes the finding.";

function artifactsEqual(left: ArtifactFiles, right: ArtifactFiles): boolean {
  return ARTIFACT_FILES.every((path) => left[path] === right[path]);
}

async function main() {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.log("DeepSeek smoke skipped: DEEPSEEK_API_KEY is not configured.");
    return;
  }

  const request = process.argv.slice(2).join(" ").trim()
    || "Build a counter with one button and visible result.";
  const input = { baseArtifact: null, buildRequest: request };
  let artifact = await deepSeekProvider.generate(input);
  let previousRepairWasUnchanged = false;

  for (let attempt = 0; attempt <= MAX_REPAIR_ATTEMPTS; attempt += 1) {
    try {
      await validateArtifactSmoke(validateArtifact(artifact));
      console.log(
        attempt === 0
          ? "DeepSeek smoke passed: artifact interaction validated."
          : `DeepSeek smoke passed after ${attempt} incremental repair${attempt === 1 ? "" : "s"}.`,
      );
      return;
    } catch (error) {
      let diagnostic = getValidationDiagnostic(error);
      if (previousRepairWasUnchanged) {
        diagnostic = `${diagnostic} ${UNCHANGED_REPAIR_FINDING}`;
      }
      if (attempt >= MAX_REPAIR_ATTEMPTS || !deepSeekProvider.repair) {
        console.error(
          `DeepSeek smoke failed: artifact_invalid (${diagnostic})`,
        );
        process.exitCode = 1;
        return;
      }
      const patch = await deepSeekProvider.repair(input, artifact, diagnostic);
      const repaired = applyArtifactRepair(
        artifact as ArtifactFiles,
        patch,
      ).files;
      previousRepairWasUnchanged = artifactsEqual(
        artifact as ArtifactFiles,
        repaired,
      );
      artifact = repaired;
    }
  }
}

main().catch((error: unknown) => {
  const category =
    error instanceof Error &&
    (error.message.startsWith("provider_") ||
      error.message === "artifact_invalid")
      ? error.message
      : "artifact_invalid";
  console.error(`DeepSeek smoke failed: ${category}`);
  process.exitCode = 1;
});
