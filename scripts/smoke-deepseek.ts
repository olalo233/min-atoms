import { deepSeekProvider } from "../src/lib/generation/deepseek";
import { applyArtifactRepair } from "../src/lib/generation/patch";
import type { ArtifactFiles } from "../src/lib/generation/types";
import {
  getValidationDiagnostic,
  validateArtifact,
} from "../src/lib/generation/validator";
import { validateArtifactSmoke } from "../src/lib/generation/smoke";

async function main() {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.log("DeepSeek smoke skipped: DEEPSEEK_API_KEY is not configured.");
    return;
  }

  const request = process.argv.slice(2).join(" ").trim()
    || "Build a counter with one button and visible result.";
  const input = { baseArtifact: null, buildRequest: request };
  let artifact = await deepSeekProvider.generate(input);
  try {
    await validateArtifactSmoke(validateArtifact(artifact));
    console.log("DeepSeek smoke passed: artifact interaction validated.");
    return;
  } catch (error) {
    const diagnostic = getValidationDiagnostic(error);
    if (!deepSeekProvider.repair) {
      throw new Error("artifact_invalid");
    }
    const patch = await deepSeekProvider.repair(input, artifact, diagnostic);
    artifact = applyArtifactRepair(artifact as ArtifactFiles, patch).files;
  }

  try {
    await validateArtifactSmoke(validateArtifact(artifact));
    console.log("DeepSeek smoke passed: repaired artifact interaction validated.");
  } catch (error) {
    console.error(
      `DeepSeek smoke failed: artifact_invalid (${getValidationDiagnostic(error)})`,
    );
    process.exitCode = 1;
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
