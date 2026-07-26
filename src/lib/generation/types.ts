export const ACTIVE_GENERATION_STATUSES = [
  "queued",
  "planning",
  "generating",
  "validating",
  "repairing",
] as const;

export const GENERATION_STAGES = [
  ...ACTIVE_GENERATION_STATUSES,
  "completed",
  "failed",
  "cancelled",
] as const;

export type GenerationStage = (typeof GENERATION_STAGES)[number];
export type ActiveGenerationStage = (typeof ACTIVE_GENERATION_STATUSES)[number];

export const ARTIFACT_FILES = [
  "index.html",
  "styles.css",
  "app.js",
  "manifest.json",
] as const;

export type ArtifactFileName = (typeof ARTIFACT_FILES)[number];
export type ArtifactFiles = Record<ArtifactFileName, string>;

export type BaseArtifact = {
  files: ArtifactFiles;
  id: string;
  version: number;
};

export type GenerationInput = {
  baseArtifact: BaseArtifact | null;
  buildRequest: string;
};

export type GenerationSnapshot = {
  job: {
    id: string;
    projectId: string;
    buildRequestId: string;
    baseVersionId: string | null;
    status: GenerationStage;
    errorMessage: string | null;
    createdAt: string;
    updatedAt: string;
    completedAt: string | null;
  } | null;
  events: Array<{
    id: string;
    sequence: number;
    stage: GenerationStage;
    message: string;
    createdAt: string;
  }>;
  artifactVersion: {
    id: string;
    version: number;
    files: ArtifactFiles;
    createdAt: string;
  } | null;
  versions: Array<{
    createdAt: string;
    id: string;
    version: number;
  }>;
};
