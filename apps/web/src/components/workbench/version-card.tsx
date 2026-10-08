"use client";

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
    <div className="flex items-center gap-3 rounded-2xl border border-indigo-500/60 bg-indigo-50/50 px-4 py-3">
      <div className="min-w-0 flex-1">
        <span className="text-sm font-medium text-indigo-900">版本 {number}</span>
        {summary && <span className="ml-2 text-sm break-words text-zinc-600">· {summary}</span>}
      </div>
      {isCurrent ? (
        <span className="shrink-0 rounded-full bg-indigo-600 px-2 py-0.5 text-xs font-medium text-white">当前</span>
      ) : (
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={restoreBlocked}
          title={restoreBlocked ? "正在构建，完成或停止后才能恢复" : undefined}
          onClick={onRestore}
        >
          恢复
        </Button>
      )}
    </div>
  );
}
