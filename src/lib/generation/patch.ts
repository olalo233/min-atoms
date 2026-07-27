import {
  ARTIFACT_FILES,
  type ArtifactFileName,
  type ArtifactFiles,
  type ArtifactRepairPatch,
} from "@/lib/generation/types";

const MAX_FILE_SIZE = 40_000;
const artifactFileNames = new Set<string>(ARTIFACT_FILES);

export class ArtifactRepairError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactRepairError";
  }
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

export function applyArtifactRepair(
  candidate: ArtifactFiles,
  response: unknown,
): { files: ArtifactFiles; patch: ArtifactRepairPatch } {
  if (
    !response ||
    typeof response !== "object" ||
    Array.isArray(response) ||
    !exactKeys(response as Record<string, unknown>, ["operations"])
  ) {
    throw new ArtifactRepairError("Incremental Repair must satisfy the exact patch contract.");
  }

  const operations = (response as Record<string, unknown>).operations;
  if (
    !Array.isArray(operations) ||
    operations.length < 1 ||
    operations.length > ARTIFACT_FILES.length
  ) {
    throw new ArtifactRepairError(
      "Incremental Repair must contain between one and four operations.",
    );
  }

  const seen = new Set<ArtifactFileName>();
  const parsed: ArtifactRepairPatch["operations"] = [];
  for (const value of operations) {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !exactKeys(value as Record<string, unknown>, ["content", "op", "path"])
    ) {
      throw new ArtifactRepairError(
        "Incremental Repair must satisfy the exact operation contract.",
      );
    }
    const operation = value as Record<string, unknown>;
    if (
      operation.op !== "replace-file" ||
      typeof operation.path !== "string" ||
      !artifactFileNames.has(operation.path)
    ) {
      throw new ArtifactRepairError(
        "Incremental Repair may replace only an approved Artifact file.",
      );
    }
    const path = operation.path as ArtifactFileName;
    if (seen.has(path)) {
      throw new ArtifactRepairError(
        "Incremental Repair may replace each Artifact file only once.",
      );
    }
    if (
      typeof operation.content !== "string" ||
      operation.content.length > MAX_FILE_SIZE
    ) {
      throw new ArtifactRepairError(
        "Incremental Repair file content must be a bounded string content.",
      );
    }
    seen.add(path);
    parsed.push({
      content: operation.content,
      op: "replace-file",
      path,
    });
  }

  const files = { ...candidate };
  for (const operation of parsed) {
    files[operation.path] = operation.content;
  }
  return { files, patch: { operations: parsed } };
}
