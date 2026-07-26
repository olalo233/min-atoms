"use client";

import { startTransition, useEffect, useState } from "react";

import { PreviewFrame } from "@/components/preview/preview-frame";
import {
  ACTIVE_GENERATION_STATUSES,
  type GenerationSnapshot,
} from "@/lib/generation/types";

type GenerationPanelProps = {
  buildRequest: string;
  projectId: string;
  initialGeneration: GenerationSnapshot;
};

const stageLabels: Record<string, string> = {
  cancelled: "Cancelled",
  completed: "Ready",
  failed: "Failed",
  generating: "Fabricate",
  planning: "Plan",
  queued: "Queued",
  repairing: "Repair",
  validating: "Validate",
};

const activeStatuses = new Set<string>(ACTIVE_GENERATION_STATUSES);

const POLL_INTERVAL_MS = 500;

function getStageLabel(stage: string) {
  return stageLabels[stage] ?? stage.replaceAll("_", " ");
}

function getFailureDetail(errorMessage: string | null | undefined) {
  if (errorMessage === "artifact_invalid") {
    return "The generated files did not pass the constrained artifact checks.";
  }
  if (errorMessage?.startsWith("provider_")) {
    return "The AI provider could not return a usable artifact. Retry when it is available.";
  }
  if (errorMessage === "generation_failed") {
    return "Generation stopped before an artifact could be accepted.";
  }
  return errorMessage ?? "Generation failed validation.";
}

function getStateCopy(status: string | null) {
  switch (status) {
    case "queued":
      return {
        detail: "The request is persisted and waiting for the Agent.",
        label: "Queued",
        tone: "queued",
      };
    case "planning":
      return {
        detail: "The Agent is defining the constrained four-file result.",
        label: "Planning",
        tone: "active",
      };
    case "generating":
      return {
        detail: "The Agent is producing the interactive artifact.",
        label: "Generating",
        tone: "active",
      };
    case "validating":
      return {
        detail: "The files are being checked before Preview can open.",
        label: "Validating",
        tone: "active",
      };
    case "repairing":
      return {
        detail: "Validation found a bounded issue. One fix-forward repair is underway.",
        label: "Repairing",
        tone: "repairing",
      };
    case "failed":
      return {
        detail: "No new version was accepted. You can safely retry this request.",
        label: "Generation failed",
        tone: "failed",
      };
    case "cancelled":
      return {
        detail: "The request was cancelled before a new version was accepted. You can requeue it safely.",
        label: "Generation cancelled",
        tone: "failed",
      };
    case "completed":
      return {
        detail: "Validation passed. This Artifact Version is ready to inspect.",
        label: "Preview ready",
        tone: "completed",
      };
    default:
      return {
        detail: "Start generation when you are ready. Nothing is running yet.",
        label: "Awaiting generation",
        tone: "empty",
      };
  }
}

export function GenerationPanel({
  buildRequest,
  projectId,
  initialGeneration,
}: GenerationPanelProps) {
  const [generation, setGeneration] = useState(initialGeneration);
  const [displayArtifact, setDisplayArtifact] = useState(initialGeneration.artifactVersion);
  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isFollowingUp, setIsFollowingUp] = useState(false);
  const [followUp, setFollowUp] = useState("");
  const [error, setError] = useState<string | null>(null);
  const status = generation.job?.status ?? null;
  const isActive = Boolean(status && activeStatuses.has(status));
  const isRetryable = status === "failed" || status === "cancelled";

  useEffect(() => {
    if (!isActive) {
      return;
    }

    let stopped = false;
    let timer: number | undefined;

    async function refresh() {
      try {
        const response = await fetch(`/api/projects/${projectId}/generation`, {
          cache: "no-store",
        });
        if (!response.ok) {
          return;
        }
        const next = (await response.json()) as GenerationSnapshot;
        startTransition(() => {
          setGeneration(next);
          setDisplayArtifact((current) =>
            next.job?.status === "completed"
              ? next.artifactVersion
              : current ?? next.artifactVersion,
          );
        });
      } catch {
        setError("Progress could not be refreshed. The persisted timeline is safe.");
      }
    }

    function scheduleNext() {
      timer = window.setTimeout(() => {
        if (stopped) {
          return;
        }
        if (document.visibilityState !== "visible") {
          // Polling pauses while the tab is hidden; the visibilitychange
          // listener below resumes it when the workspace is visible again.
          return;
        }
        void refresh().then(() => {
          if (!stopped) {
            scheduleNext();
          }
        });
      }, POLL_INTERVAL_MS);
    }

    function handleVisibilityChange() {
      if (stopped || document.visibilityState !== "visible") {
        return;
      }
      window.clearTimeout(timer);
      void refresh().then(() => {
        if (!stopped) {
          scheduleNext();
        }
      });
    }

    scheduleNext();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [isActive, projectId]);

  async function startGeneration() {
    setError(null);
    setIsStarting(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/generation`, {
        method: "POST",
      });
      const body = (await response.json()) as GenerationSnapshot & { error?: string };
      if (!response.ok) {
        setError(body.error ?? "Generation could not start.");
        return;
      }
      setGeneration(body);
      setDisplayArtifact(body.artifactVersion);
    } catch {
      setError("Generation could not start. Please try again.");
    } finally {
      setIsStarting(false);
    }
  }

  async function stopGeneration() {
    setError(null);
    setIsStopping(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/generation`, {
        method: "DELETE",
      });
      const body = (await response.json()) as GenerationSnapshot & { error?: string };
      if (!response.ok) {
        setError(body.error ?? "The agent could not be stopped. Try again.");
        return;
      }
      setGeneration(body);
      setDisplayArtifact((current) => current ?? body.artifactVersion);
    } catch {
      setError("The agent could not be stopped. Try again.");
    } finally {
      setIsStopping(false);
    }
  }

  async function selectVersion(versionId: string) {
    setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/versions/${versionId}`, { cache: "no-store" });
      const body = (await response.json()) as { artifactVersion?: NonNullable<GenerationSnapshot["artifactVersion"]>; error?: string };
      if (!response.ok || !body.artifactVersion) {
        setError(body.error ?? "Artifact Version could not be opened.");
        return;
      }
      setDisplayArtifact(body.artifactVersion);
    } catch {
      setError("Artifact Version could not be opened. Please try again.");
    }
  }

  async function restoreVersion() {
    if (!displayArtifact) return;
    setError(null);
    try {
      const response = await fetch(
        `/api/projects/${projectId}/versions/${displayArtifact.id}/restore`,
        { method: "POST" },
      );
      const body = (await response.json()) as GenerationSnapshot & { error?: string };
      if (!response.ok) {
        setError(body.error ?? "Artifact Version could not be restored.");
        return;
      }
      setGeneration(body);
      setDisplayArtifact(body.artifactVersion);
    } catch {
      setError("Artifact Version could not be restored. Please try again.");
    }
  }

  async function submitFollowUp() {
    if (!displayArtifact || !followUp.trim()) return;
    setError(null);
    setIsFollowingUp(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/follow-up`, {
        body: JSON.stringify({ baseVersionId: displayArtifact.id, buildRequest: followUp }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const body = (await response.json()) as GenerationSnapshot & { error?: string };
      if (!response.ok) {
        setError(body.error ?? "Follow-up Build Request could not start.");
        return;
      }
      setGeneration(body);
      setFollowUp("");
    } catch {
      setError("Follow-up Build Request could not start. Please try again.");
    } finally {
      setIsFollowingUp(false);
    }
  }

  const stateCopy = getStateCopy(status);
  const showStartAction = !generation.job || isRetryable;
  const hasPreview = Boolean(displayArtifact);

  return (
    <section className="generation-section" aria-labelledby="generation-title">
      <h2 className="visually-hidden" id="generation-title">Builder workbench</h2>
      <div className="builder-grid">
        <aside className="evidence-column" aria-label="Build Request and generation evidence">
          <section className="request-panel" aria-labelledby="request-title">
            <div>
              <p className="request-label" id="request-title">Build Request</p>
              <p className="request-content">{buildRequest}</p>
            </div>
          </section>

          <section className="proof-panel" aria-labelledby="proof-title">
            <div className="proof-heading">
              <div>
                <p className="request-label">Persisted evidence</p>
                <h3 id="proof-title">Generation timeline</h3>
              </div>
              <span className="event-count">
                {generation.events.length} {generation.events.length === 1 ? "event" : "events"}
              </span>
            </div>
            <ol className="generation-timeline" aria-label="Generation progress">
              {generation.events.length > 0 ? (
                generation.events.map((event) => {
                  const isCurrent = status === event.stage && isActive;
                  const stepState = event.stage === "failed" || event.stage === "cancelled"
                    ? "is-failed"
                    : isCurrent
                      ? "is-current"
                      : "is-complete";
                  return (
                    <li
                      className={`timeline-step ${stepState} stage-${event.stage}`}
                      key={event.id}
                    >
                      <span className="timeline-marker" aria-hidden="true" />
                      <span className="timeline-content">
                        <span className="timeline-label">
                          <strong>{getStageLabel(event.stage)}</strong>
                          <small>Step {event.sequence}</small>
                        </span>
                        <span className="timeline-message">{event.message}</span>
                      </span>
                    </li>
                  );
                })
              ) : (
                <li className="timeline-step is-pending">
                  <span className="timeline-marker" aria-hidden="true" />
                  <span className="timeline-content">
                    <span className="timeline-label">
                      <strong>Awaiting first event</strong>
                      <small>Not started</small>
                    </span>
                    <span className="timeline-message">
                      The proof rail will show persisted Generation Events here.
                    </span>
                  </span>
                </li>
              )}
            </ol>
          </section>
        </aside>

        <div className={`preview-panel state-${stateCopy.tone}`}>
          <div className="job-state">
            <span className="agent-pulse" aria-hidden="true">
              <span className="agent-pulse-dot" />
            </span>
            <span
              aria-atomic="true"
              aria-live="polite"
              className="job-state-copy"
              role="status"
            >
              <strong>{stateCopy.label}</strong>
              <small>{stateCopy.detail}</small>
            </span>
            <span className="job-actions">
              {isActive ? (
                <button
                  aria-busy={isStopping}
                  className="quiet-button stop-button"
                  disabled={isStopping}
                  onClick={() => void stopGeneration()}
                  type="button"
                >
                  {isStopping ? "Stopping…" : "Stop agent"}
                </button>
              ) : null}
              {showStartAction ? (
                <button
                  aria-busy={isStarting}
                  className="primary-button"
                  disabled={isStarting}
                  onClick={startGeneration}
                  type="button"
                >
                  {isStarting ? (
                    <><span className="loading-mark" aria-hidden="true" />Queueing generation…</>
                  ) : status === "cancelled" ? (
                    "Requeue generation"
                  ) : status === "failed" ? (
                    "Retry generation"
                  ) : (
                    "Generate first version"
                  )}
                </button>
              ) : null}
            </span>
          </div>

          {isRetryable ? (
            <div className="failure-notice" role="alert">
              <strong>{status === "cancelled" ? "Generation cancelled" : "Artifact not accepted"}</strong>
              <span>{status === "cancelled"
                ? "No new version was accepted. You can requeue the unchanged Build Request."
                : getFailureDetail(generation.job?.errorMessage)}</span>
              <span>The Build Request is unchanged and no successful version was overwritten.</span>
            </div>
          ) : null}
          {error ? <p className="error" role="alert">{error}</p> : null}

          {generation.versions.length > 0 ? (
            <section className="version-panel" aria-labelledby="version-title">
              <div>
                <p className="request-label">Version history</p>
                <h3 id="version-title">Inspect without changing the active result</h3>
              </div>
              <div className="version-controls" role="list" aria-label="Successful Artifact Versions">
                {generation.versions.map((version) => (
                  <button
                    aria-pressed={displayArtifact?.id === version.id}
                    className="quiet-button"
                    key={version.id}
                    onClick={() => void selectVersion(version.id)}
                    type="button"
                  >
                    v{version.version}{generation.artifactVersion?.id === version.id ? " · active" : ""}
                  </button>
                ))}
              </div>
              {displayArtifact && displayArtifact.id !== generation.artifactVersion?.id ? (
                <button className="quiet-button" onClick={() => void restoreVersion()} type="button">
                  Restore v{displayArtifact.version} as active
                </button>
              ) : null}
            </section>
          ) : null}

          {hasPreview && displayArtifact ? (
            <>
              <div className="preview-heading">
                <div>
                  <p className="eyebrow">Artifact Version {displayArtifact.version}</p>
                  <h3>Inspect the result</h3>
                </div>
                <span className="preview-badge">No network · no navigation</span>
              </div>
              <PreviewFrame
                artifactVersionId={displayArtifact.id}
                files={displayArtifact.files}
                projectId={projectId}
              />
            </>
          ) : (
            <div className="preview-waiting" aria-hidden="true">
              <div className="waiting-register">
                <span>Preview</span>
                <span>{isRetryable ? "No accepted output" : "Awaiting validated output"}</span>
              </div>
              <div className="waiting-aperture">
                <span className="waiting-mark" />
                <p>
                  {status === "cancelled"
                    ? "Requeue to produce a new candidate."
                    : status === "failed"
                      ? "Retry to produce a new candidate."
                    : isActive
                      ? "The Preview opens only after validation passes."
                      : "Start generation to create an inspectable Artifact Version."}
                </p>
              </div>
            </div>
          )}

          {displayArtifact ? (
            <section className="follow-up-panel" aria-labelledby="follow-up-title">
              <p className="request-label">Continue from v{displayArtifact.version}</p>
              <h3 id="follow-up-title">Follow-up Build Request</h3>
              <label className="visually-hidden" htmlFor="follow-up-request">Describe the next change</label>
              <textarea
                id="follow-up-request"
                onChange={(event) => setFollowUp(event.target.value)}
                placeholder="Describe the change for a new immutable version."
                value={followUp}
              />
              <button
                className="primary-button"
                disabled={isActive || isFollowingUp || !followUp.trim()}
                onClick={() => void submitFollowUp()}
                type="button"
              >
                {isFollowingUp ? "Queueing follow-up…" : `Generate from v${displayArtifact.version}`}
              </button>
            </section>
          ) : null}
        </div>
      </div>
    </section>
  );
}
