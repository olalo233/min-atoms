"use client";

import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { VersionDTO } from "@min-atoms/protocol";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { formatRelativeTime } from "@/lib/client/format";

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
        <Button type="button" variant="outline" size="sm" className="rounded-xl" disabled={sorted.length === 0}>
          {current ? `版本：v${current.number}` : "暂无版本"}
          <ChevronDown className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        {sorted.map((version) => {
          const isCurrent = version.id === currentVersionId;
          return (
            <DropdownMenuItem
              key={version.id}
              disabled={isCurrent || restoreBlocked}
              title={!isCurrent && restoreBlocked ? "正在构建，完成或停止后才能恢复" : undefined}
              onSelect={() => onRestoreRequest(version)}
              className="flex items-center gap-2"
            >
              <span className="min-w-0 flex-1 truncate text-sm">
                v{version.number} · {version.summary} · {formatRelativeTime(version.createdAt, openedAt)}
              </span>
              {isCurrent ? (
                <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-indigo-600">
                  <Check className="size-3" />
                  当前
                </span>
              ) : (
                <span className="shrink-0 text-xs text-indigo-600">恢复</span>
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
