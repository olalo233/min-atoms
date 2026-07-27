"use client";

import {
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { PreviewFrame } from "@/components/preview/preview-frame";
import {
  ACTIVE_GENERATION_STATUSES,
  type ConversationMode,
  GENERATION_STEP_LEASE_MS,
  type GenerationSnapshot,
  type ProjectMessageSnapshot,
} from "@/lib/generation/types";

type GenerationPanelProps = {
  buildRequest: string;
  projectId: string;
  initialGeneration: GenerationSnapshot;
  initialMessages?: ProjectMessageSnapshot[];
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

const POLL_INTERVAL_MS = 1_200;

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
  if (errorMessage === "artifact_stalled") {
    return "The incremental repair did not change the candidate, so the agent stopped instead of spending more attempts.";
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
        detail: "The last candidate and diagnostic are persisted. The next incremental repair can continue safely.",
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
  initialMessages,
}: GenerationPanelProps) {
  const [generation, setGeneration] = useState(initialGeneration);
  const [displayArtifact, setDisplayArtifact] = useState(initialGeneration.artifactVersion);
  const [messages, setMessages] = useState<ProjectMessageSnapshot[]>(
    initialMessages ?? [
      {
        artifactVersionId: null,
        buildRequestId: initialGeneration.job?.buildRequestId ?? null,
        content: buildRequest,
        createdAt: new Date(0).toISOString(),
        id: "initial-build-request",
        mode: "build",
        role: "user",
        sequence: 1,
      },
    ],
  );
  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [messageMode, setMessageMode] = useState<ConversationMode>("build");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const continuedRepairRef = useRef<string | null>(null);
  const conversationEndRef = useRef<HTMLDivElement | null>(null);
  const status = generation.job?.status ?? null;
  const isActive = Boolean(status && activeStatuses.has(status));
  const isRetryable = status === "failed" || status === "cancelled";
  const handleRuntimeRepairQueued = useCallback(
    (next: GenerationSnapshot) => {
      setError(null);
      setGeneration(next);
    },
    [],
  );

  useEffect(() => {
    conversationEndRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [messages]);

  useEffect(() => {
    if (!isActive) {
      return;
    }

    let stopped = false;
    let timer: number | undefined;

    async function continuePersistedRepair(next: GenerationSnapshot) {
      if (!next.job) return;
      const leaseExpired =
        activeStatuses.has(next.job.status) &&
        Date.now() - new Date(next.job.updatedAt).getTime() >=
          GENERATION_STEP_LEASE_MS;
      if (next.job.status !== "repairing" && !leaseExpired) return;
      const repairKey = `${next.job.id}:${next.job.updatedAt}`;
      if (continuedRepairRef.current === repairKey) return;
      continuedRepairRef.current = repairKey;
      try {
        const response = await fetch(
          `/api/projects/${projectId}/generation`,
          { method: "POST" },
        );
        if (!response.ok) continuedRepairRef.current = null;
      } catch {
        continuedRepairRef.current = null;
      }
    }

    async function refresh() {
      try {
        const response = await fetch(`/api/projects/${projectId}/generation`, {
          cache: "no-store",
        });
        if (!response.ok) {
          return;
        }
        const next = (await response.json()) as GenerationSnapshot;
        setError(null);
        startTransition(() => {
          setGeneration(next);
          setDisplayArtifact((current) =>
            next.job?.status === "completed"
              ? next.artifactVersion
              : current ?? next.artifactVersion,
          );
        });
        if (next.job?.status === "completed") {
          const messagesResponse = await fetch(
            `/api/projects/${projectId}/messages`,
            { cache: "no-store" },
          );
          if (messagesResponse.ok) {
            const messageBody = (await messagesResponse.json()) as {
              messages: ProjectMessageSnapshot[];
            };
            if (Array.isArray(messageBody.messages)) {
              setMessages(messageBody.messages);
            }
          }
        }
        await continuePersistedRepair(next);
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

  async function submitMessage() {
    if (!draft.trim() || (messageMode === "build" && !displayArtifact)) return;
    setError(null);
    setIsSending(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/messages`, {
        body: JSON.stringify(
          messageMode === "build"
            ? {
                baseVersionId: displayArtifact?.id,
                content: draft,
                mode: "build",
              }
            : { content: draft, mode: "chat" },
        ),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const body = (await response.json()) as {
        error?: string;
        generation?: GenerationSnapshot;
        messages?: ProjectMessageSnapshot[];
      };
      if (body.messages) setMessages(body.messages);
      if (!response.ok) {
        setError(body.error ?? "The message could not be sent.");
        return;
      }
      if (body.generation) setGeneration(body.generation);
      setDraft("");
    } catch {
      setError("The message could not be sent. Please try again.");
    } finally {
      setIsSending(false);
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
          <section className="conversation-panel" aria-labelledby="conversation-title">
            <div className="conversation-heading">
              <div>
                <p className="request-label">Project conversation</p>
                <h3 id="conversation-title">You and the Agent</h3>
              </div>
              <span className="event-count">{messages.length}</span>
            </div>
            <ol className="conversation-list">
              {messages.map((message) => (
                <li
                  className={`conversation-message is-${message.role}`}
                  key={message.id}
                >
                  <div className="message-meta">
                    <strong>{message.role === "user" ? "You" : "Agent"}</strong>
                    <span>{message.mode === "build" ? "Build" : "Chat"}</span>
                  </div>
                  <p>{message.content}</p>
                  {message.artifactVersionId ? (
                    <button
                      className="message-version-link"
                      onClick={() =>
                        void selectVersion(message.artifactVersionId as string)
                      }
                      type="button"
                    >
                      Open produced version
                    </button>
                  ) : null}
                </li>
              ))}
            </ol>
            <div ref={conversationEndRef} />
          </section>

          <details className="proof-panel">
            <summary className="proof-heading">
              <div>
                <p className="request-label">Persisted evidence</p>
                <h3>Generation timeline</h3>
              </div>
              <span className="event-count">
                {generation.events.length} {generation.events.length === 1 ? "event" : "events"}
              </span>
            </summary>
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
          </details>

          {generation.versions.length > 0 ? (
            <section className="version-panel" aria-labelledby="version-title">
              <div className="sidebar-section-heading">
                <div>
                  <p className="request-label">Version history</p>
                  <h3 id="version-title">Artifact versions</h3>
                </div>
                <span className="event-count">{generation.versions.length}</span>
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
                <button className="quiet-button restore-button" onClick={() => void restoreVersion()} type="button">
                  Restore v{displayArtifact.version} as active
                </button>
              ) : null}
            </section>
          ) : null}

          <section className="follow-up-panel conversation-composer" aria-labelledby="follow-up-title">
            <div className="composer-title-row">
              <div>
                <p className="request-label">
                  {messageMode === "build" && displayArtifact
                    ? `Continue from v${displayArtifact.version}`
                    : "Talk with the Agent"}
                </p>
                <h3 id="follow-up-title">Describe the next change</h3>
              </div>
              <div className="mode-switch" aria-label="Agent behavior" role="group">
                <button
                  aria-pressed={messageMode === "chat"}
                  onClick={() => setMessageMode("chat")}
                  type="button"
                >
                  Chat
                </button>
                <button
                  aria-pressed={messageMode === "build"}
                  onClick={() => setMessageMode("build")}
                  type="button"
                >
                  Build
                </button>
              </div>
            </div>
            <label className="visually-hidden" htmlFor="conversation-request">
              Message the Agent
            </label>
            <textarea
              id="conversation-request"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  (event.metaKey || event.ctrlKey)
                ) {
                  event.preventDefault();
                  void submitMessage();
                }
              }}
              placeholder={
                messageMode === "build"
                  ? "Describe the feature or visual change to build…"
                  : "Ask a question or discuss what to build next…"
              }
              value={draft}
            />
            <div className="composer-action-row">
              <small>
                {messageMode === "build"
                  ? "Creates a new version using the full conversation."
                  : "Replies in chat without changing the artifact."}
              </small>
              <button
                className="primary-button"
                disabled={
                  isSending ||
                  !draft.trim() ||
                  (messageMode === "build" && (isActive || !displayArtifact))
                }
                onClick={() => void submitMessage()}
                type="button"
              >
                {isSending
                  ? "Sending…"
                  : messageMode === "build"
                    ? "Build version"
                    : "Send"}
              </button>
            </div>
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

          {hasPreview && displayArtifact ? (
            <>
              <div className="preview-heading">
                <div>
                  <p className="eyebrow">App viewer</p>
                  <h3>Artifact Version {displayArtifact.version}</h3>
                </div>
                <span className="preview-badge">No network · no navigation</span>
              </div>
              <PreviewFrame
                artifactVersionId={displayArtifact.id}
                files={displayArtifact.files}
                onRuntimeRepairQueued={handleRuntimeRepairQueued}
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
        </div>
      </div>
    </section>
  );
}
