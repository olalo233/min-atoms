"use client";

import { useState } from "react";
import { ChevronRight, CircleAlert, Clock, LoaderCircle, RotateCw, Square, WandSparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { limitLines } from "@/lib/client/format";
import { isActivePhase, runDurationText, statusLineText, type RunViewData } from "@/lib/client/store";

import { DEFAULT_AGENT, type AgentIdentity } from "./agent-identity";
import { AtomAvatar } from "./atom-avatar";
import { Markdown } from "./markdown";
import { StepList } from "./step-list";
import { VersionCard } from "./version-card";

interface RunBlockProps {
  run: RunViewData;
  /** Body text: live text deltas, or the assistant message for finished runs. */
  finalText: string | null;
  cancelledNote: string;
  vmUp: boolean | null;
  currentVersionId: string | null;
  restoreBlocked: boolean;
  onRestoreRequest: (versionId: string) => void;
  /** "让 AI 修复": sends the standard fix-up build message. */
  onFix: () => void;
  /** "重试" after an environment restart: resends the original message. */
  onRetryRun: (run: RunViewData) => void;
}

/* ── Regions ─────────────────────────────────────────────────────────────
 * A run block is a column of independent regions, top to bottom:
 *   RunHeader → [phase 2: RunPlan] → RunSteps → RunStatus → RunBody →
 *   [phase 2: steer bubbles] → RunOutcome
 * Phase 2 (p3.md §7.2) slots the plan checklist above the steps, nests
 * dispatch rows inside the rail, and adds steer bubbles before the outcome
 * without touching the other regions.
 */

function RunHeader({ agent, active }: { agent: AgentIdentity; active: boolean }) {
  return (
    <p className="flex h-7 items-center gap-1 text-sm">
      <span className="font-semibold text-zinc-900">{agent.name}</span>
      <span aria-hidden="true" className="text-zinc-300">
        ·
      </span>
      <span className="text-zinc-500">{agent.role}</span>
      {active && <span className="sr-only">（正在工作）</span>}
    </p>
  );
}

function RunStatus({ text, working }: { text: string; working: boolean }) {
  return (
    <p className="flex min-w-0 items-center gap-1.5 text-[13px] leading-5" aria-live="polite">
      {working ? (
        <span className="wb-glimmer min-w-0 truncate">{text}</span>
      ) : (
        <>
          <Clock className="size-3.5 shrink-0 text-zinc-400" aria-hidden="true" />
          <span className="min-w-0 truncate text-zinc-500">{text}</span>
        </>
      )}
    </p>
  );
}

function FailureBlock({ run, onFix, onRetryRun }: { run: RunViewData; onFix: () => void; onRetryRun: () => void }) {
  const [busy, setBusy] = useState(false);
  const envRestart = /环境重启/.test(`${run.failedDetail ?? ""}\n${run.errors.join("\n")}`);
  const reason = run.failedDetail ?? "构建检查未通过";
  const details = run.errors.join("\n");

  const handleClick = () => {
    setBusy(true);
    if (envRestart) onRetryRun();
    else onFix();
    // The optimistic message/run appears immediately; reset the button shortly after.
    setTimeout(() => setBusy(false), 400);
  };

  return (
    <div className="wb-enter flex gap-2.5 rounded-xl bg-red-50/80 px-3.5 py-3 ring-1 ring-red-600/15" role="group" aria-label="构建失败">
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-red-600" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-red-700">{envRestart ? "运行被中断：演示环境重启了" : "构建未通过"}</p>
        {!envRestart && <p className="mt-0.5 text-sm [overflow-wrap:anywhere] text-red-700/80">{reason}</p>}
        {details && (
          <details className="group/details mt-2">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded text-xs font-medium text-red-600/80 hover:text-red-700 [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-3 transition-transform duration-150 group-open/details:rotate-90" aria-hidden="true" />
              详情
            </summary>
            <pre className="mt-1.5 max-h-60 overflow-auto rounded-lg bg-white/70 p-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap text-red-900/90 ring-1 ring-red-600/10 [overflow-wrap:anywhere]">
              {limitLines(details, 20)}
            </pre>
          </details>
        )}
        <Button type="button" size="sm" className="mt-3" disabled={busy} aria-busy={busy} onClick={handleClick}>
          {busy ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : envRestart ? (
            <RotateCw className="size-3.5" />
          ) : (
            <WandSparkles className="size-3.5" />
          )}
          {envRestart ? "重试" : "让 AI 修复"}
        </Button>
      </div>
    </div>
  );
}

function RunOutcome({
  run,
  cancelledNote,
  currentVersionId,
  restoreBlocked,
  onRestoreRequest,
  onFix,
  onRetryRun,
}: Pick<RunBlockProps, "run" | "cancelledNote" | "currentVersionId" | "restoreBlocked" | "onRestoreRequest" | "onFix" | "onRetryRun">) {
  const version = run.version;
  return (
    <>
      {version && (
        <VersionCard
          number={version.number}
          summary={version.summary}
          isCurrent={version.versionId === currentVersionId}
          restoreBlocked={restoreBlocked}
          onRestore={() => onRestoreRequest(version.versionId)}
        />
      )}
      {run.phase === "failed" && <FailureBlock run={run} onFix={onFix} onRetryRun={() => onRetryRun(run)} />}
      {run.phase === "cancelled" && (
        <p className="flex items-center gap-1.5 text-[13px] text-zinc-500">
          <Square className="size-3 shrink-0 fill-current text-zinc-400" aria-hidden="true" />
          {cancelledNote}
        </p>
      )}
    </>
  );
}

/** One assistant message: header, steps, status line, body, outcome (ux §6.2). */
export function RunBlock({
  run,
  finalText,
  cancelledNote,
  vmUp,
  currentVersionId,
  restoreBlocked,
  onRestoreRequest,
  onFix,
  onRetryRun,
}: RunBlockProps) {
  const active = isActivePhase(run.phase);
  const statusText = statusLineText(run, vmUp);
  const showSteps = run.mode === "build" && run.steps.length > 0;
  const streaming = active && run.hasTextEvents;
  const agent = DEFAULT_AGENT;

  return (
    <article className="wb-enter flex gap-3" aria-label={`${agent.name} · ${agent.role}`}>
      <AtomAvatar tone={agent.tone} />
      <div className="min-w-0 flex-1 space-y-3">
        <RunHeader agent={agent} active={active} />
        {showSteps && <StepList steps={run.steps} running={active} durationText={runDurationText(run)} />}
        {statusText && <RunStatus text={statusText} working={run.phase !== "queued"} />}
        {finalText && <Markdown text={finalText} streaming={streaming} />}
        <RunOutcome
          run={run}
          cancelledNote={cancelledNote}
          currentVersionId={currentVersionId}
          restoreBlocked={restoreBlocked}
          onRestoreRequest={onRestoreRequest}
          onFix={onFix}
          onRetryRun={onRetryRun}
        />
      </div>
    </article>
  );
}
