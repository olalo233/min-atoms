"use client";

import { useState } from "react";
import { ArrowLeft, EllipsisVertical, LoaderCircle } from "lucide-react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { RunViewData, TimelineItem, WorkbenchState } from "@/lib/client/store";
import type { RunMode } from "@/lib/client/source";
import { cn } from "@/lib/utils";

import { Composer } from "./composer";
import { MessageList, type MessageActions } from "./message-list";

interface ConversationPaneProps {
  className?: string;
  state: WorkbenchState;
  timeline: TimelineItem[];
  activeRun: RunViewData | undefined;
  restoreBlocked: boolean;
  deleteBlocked: boolean;
  onBack: () => void;
  onDelete: () => Promise<void>;
  onSend: (content: string, mode: RunMode) => void;
  onStop: (runId: string) => void;
  /** Bumped each time the user sends; MessageList jumps to the bottom. */
  sendSignal: number;
  actions: MessageActions;
}

/** Left column (ux §6.1): header with back/name/menu, scrollable conversation, composer pinned to the bottom. */
export function ConversationPane({
  className,
  state,
  timeline,
  activeRun,
  restoreBlocked,
  deleteBlocked,
  onBack,
  onDelete,
  onSend,
  onStop,
  sendSignal,
  actions,
}: ConversationPaneProps) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await onDelete();
    } catch {
      setDeleteError("删除失败，请重试");
      setDeleting(false);
    }
  };

  return (
    <section className={cn("min-h-0 w-full flex-col bg-zinc-50 lg:w-[35%] lg:min-w-[380px] lg:shrink-0 lg:border-r lg:border-zinc-200", className)}>
      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-zinc-200 bg-white px-2">
        <button
          type="button"
          onClick={onBack}
          title="返回首页"
          className="flex size-8 shrink-0 items-center justify-center rounded-xl text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800"
        >
          <ArrowLeft className="size-4" />
        </button>
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-800">{state.projectName}</p>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              title="项目菜单"
              className="flex size-8 shrink-0 items-center justify-center rounded-xl text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800"
            >
              <EllipsisVertical className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              disabled={deleteBlocked}
              title={deleteBlocked ? "正在构建，停止后才能删除" : undefined}
              onSelect={() => setDeleteOpen(true)}
              className="text-red-600 focus:text-red-600"
            >
              删除项目
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <MessageList state={state} timeline={timeline} restoreBlocked={restoreBlocked} sendSignal={sendSignal} actions={actions} />
      <Composer activeRun={activeRun} onSend={onSend} onStop={onStop} />

      <AlertDialog open={deleteOpen} onOpenChange={(open) => !open && !deleting && setDeleteOpen(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除项目？</AlertDialogTitle>
            <AlertDialogDescription>删除后对话、版本和应用数据都会清除，无法恢复。</AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && <p className="text-xs text-red-600">{deleteError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            <Button type="button" variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting && <LoaderCircle className="size-3.5 animate-spin" />}
              删除
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
