"use client";

import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { VersionDTO } from "@min-atoms/protocol";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatRelativeTime } from "@/lib/client/format";
import { cn } from "@/lib/utils";

interface VersionMenuProps {
  versions: VersionDTO[];
  currentVersionId: string | null;
  restoreBlocked: boolean;
  onRestoreRequest: (version: VersionDTO) => void;
}

/** Toolbar version dropdown (ux §6.4): newest first, 当前 mark, 恢复 per row. */
export function VersionMenu({ versions, currentVersionId, restoreBlocked, onRestoreRequest }: VersionMenuProps) {
  const [openedAt, setOpenedAt] = useState(0);
  const sorted = [...versions].sort((a, b) => b.number - a.number);
  const current = versions.find((v) => v.id === currentVersionId);

  return (
    <DropdownMenu onOpenChange={(open) => open && setOpenedAt(Date.now())}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1 px-2.5 data-[state=open]:bg-zinc-50"
          disabled={sorted.length === 0}
          aria-label={current ? `版本：v${current.number}，打开版本列表` : "暂无版本"}
        >
          {current ? (
            <>
              <span className="text-zinc-500">版本</span>
              <span className="font-mono text-[13px] font-semibold text-zinc-900">v{current.number}</span>
            </>
          ) : (
            <span className="text-zinc-500">暂无版本</span>
          )}
          <ChevronDown className="size-3.5 text-zinc-400" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[min(20rem,calc(100vw-1rem))]">
        <DropdownMenuLabel className="px-2.5 pt-1.5 pb-1 text-xs font-normal text-zinc-400">版本历史</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {sorted.map((version) => {
          const isCurrent = version.id === currentVersionId;
          return (
            <DropdownMenuItem
              key={version.id}
              disabled={isCurrent || restoreBlocked}
              title={!isCurrent && restoreBlocked ? "正在构建，完成或停止后才能恢复" : undefined}
              onSelect={() => onRestoreRequest(version)}
              className={cn("items-start gap-2.5", isCurrent && "data-[disabled]:opacity-100")}
              aria-current={isCurrent ? "true" : undefined}
            >
              <span
                className={cn(
                  "mt-px shrink-0 rounded-md px-1.5 font-mono text-[11px] leading-5 font-semibold",
                  isCurrent ? "bg-indigo-600 text-white" : "bg-zinc-100 text-zinc-600",
                )}
              >
                v{version.number}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-zinc-800">{version.summary || `版本 ${version.number}`}</span>
                <span className="block text-xs text-zinc-400">{formatRelativeTime(version.createdAt, openedAt)}</span>
              </span>
              {isCurrent ? (
                <span className="mt-0.5 flex shrink-0 items-center gap-1 text-xs font-medium text-indigo-600">
                  <Check className="size-3 text-current" strokeWidth={3} />
                  当前
                </span>
              ) : (
                <span className="mt-0.5 shrink-0 text-xs font-medium text-indigo-600">恢复</span>
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
