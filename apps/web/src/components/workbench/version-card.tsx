"use client";

import { Check, GitCommitHorizontal, History } from "lucide-react";

import { Button } from "@/components/ui/button";

interface VersionCardProps {
  number: number;
  summary: string;
  isCurrent: boolean;
  restoreBlocked: boolean;
  onRestore: () => void;
}

/** Indigo-outlined version card (ux §6.2), with 当前 mark or 恢复 action. */
export function VersionCard({ number, summary, isCurrent, restoreBlocked, onRestore }: VersionCardProps) {
  return (
    <div className="wb-enter flex items-center gap-3 rounded-xl bg-indigo-50/60 py-2.5 pr-2.5 pl-3 ring-1 ring-indigo-500/25">
      <span
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-white text-indigo-600 shadow-[0_1px_2px_rgb(67_56_202/0.12)] ring-1 ring-indigo-500/20"
      >
        <GitCommitHorizontal className="size-4" />
      </span>
      <p className="min-w-0 flex-1 text-sm leading-snug [overflow-wrap:anywhere]">
        <span className="font-semibold text-indigo-950">版本 {number}</span>
        {summary && <span className="text-zinc-600"> · {summary}</span>}
      </p>
      {isCurrent ? (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-indigo-600 py-0.5 pr-2 pl-1.5 text-[11px] font-medium text-white">
          <Check className="size-3" strokeWidth={3} aria-hidden="true" />
          当前
        </span>
      ) : (
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={restoreBlocked}
          title={restoreBlocked ? "正在构建，完成或停止后才能恢复" : undefined}
          aria-label={`恢复到版本 ${number}`}
          onClick={onRestore}
          className="shrink-0"
        >
          <History className="size-3" aria-hidden="true" />
          恢复
        </Button>
      )}
    </div>
  );
}
