"use client";

import { useState } from "react";
import { LoaderCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { limitLines } from "@/lib/client/format";
import { isActivePhase, runDurationText, statusLineText, type RunViewData } from "@/lib/client/store";

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

function FailureBlock({
  run,
  onFix,
  onRetryRun,
}: {
  run: RunViewData;
  onFix: () => void;
  onRetryRun: () => void;
}) {
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
    <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3">
      <p className="text-sm font-medium text-red-600">{envRestart ? "运行被中断：演示环境重启了" : "构建未通过"}</p>
      {!envRestart && <p className="mt-1 text-sm break-words text-red-600/80">{reason}</p>}
      {details && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-red-500">详情</summary>
          <pre className="mt-1 overflow-auto font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-red-800">
            {limitLines(details, 20)}
          </pre>
        </details>
      )}
      <Button type="button" size="sm" className="mt-3 rounded-xl bg-indigo-600 text-white hover:bg-indigo-600/90" disabled={busy} onClick={handleClick}>
        {busy && <LoaderCircle className="size-3.5 animate-spin" />}
        {envRestart ? "重试" : "让 AI 修复"}
      </Button>
    </div>
  );
}

/** One assistant message: header, steps, status line, body, version card, terminal states (ux §6.2). */
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
  const version = run.version;

  return (
    <div className="flex gap-3">
      <AtomAvatar />
      <div className="min-w-0 flex-1 space-y-2.5">
        <p className="pt-1 text-sm font-medium text-zinc-800">Atom · 工程师</p>
        {showSteps && <StepList steps={run.steps} running={active} durationText={runDurationText(run)} />}
        {statusText && <p className="wb-shimmer text-xs text-zinc-500">{statusText}</p>}
        {finalText && <Markdown text={finalText} streaming={streaming} />}
        {version && (
          <VersionCard
            number={version.number}
            summary={version.summary}
            isCurrent={version.versionId === currentVersionId}
            restoreBlocked={restoreBlocked}
            onRestore={() => onRestoreRequest(version.versionId)}
          />
        )}
        {run.phase === "failed" && (
          <FailureBlock run={run} onFix={onFix} onRetryRun={() => onRetryRun(run)} />
        )}
        {run.phase === "cancelled" && <p className="text-xs text-zinc-500">{cancelledNote}</p>}
      </div>
    </div>
  );
}
