const MAX_RUNTIME_DIAGNOSTIC_LENGTH = 640;

export type RuntimeDiagnosticKind =
  | "error"
  | "reload_loop"
  | "unhandledrejection";

export type RuntimeDiagnostic = {
  artifactVersionId: string;
  detail: string;
  kind: RuntimeDiagnosticKind;
  projectId: string;
  type: "min-atoms-runtime-diagnostic";
};

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
  );
}

export function parseRuntimeDiagnostic(value: unknown): RuntimeDiagnostic | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  if (
    message.type !== "min-atoms-runtime-diagnostic" ||
    (
      message.kind !== "error" &&
      message.kind !== "reload_loop" &&
      message.kind !== "unhandledrejection"
    ) ||
    !isIdentifier(message.projectId) ||
    !isIdentifier(message.artifactVersionId) ||
    typeof message.detail !== "string"
  ) {
    return null;
  }
  const detail = message.detail.trim().slice(0, MAX_RUNTIME_DIAGNOSTIC_LENGTH);
  if (!detail) return null;
  return {
    artifactVersionId: message.artifactVersionId,
    detail,
    kind: message.kind,
    projectId: message.projectId,
    type: "min-atoms-runtime-diagnostic",
  };
}
