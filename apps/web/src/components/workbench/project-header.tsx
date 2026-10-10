"use client";

import { useState, type KeyboardEvent } from "react";
import { ArrowLeft, EllipsisVertical, LoaderCircle, Trash2 } from "lucide-react";

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
import { cn } from "@/lib/utils";

export type WorkbenchTab = "chat" | "preview";

export const ICON_BUTTON =
  "press flex size-8 shrink-0 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-950/[0.05] hover:text-zinc-900 disabled:pointer-events-none disabled:opacity-35";

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button type="button" onClick={onBack} aria-label="返回首页" title="返回首页" className={ICON_BUTTON}>
      <ArrowLeft className="size-4" />
    </button>
  );
}

/** "⋯" project menu with the delete confirmation (ux §6.1). */
export function ProjectMenu({ deleteBlocked, onDelete }: { deleteBlocked: boolean; onDelete: () => Promise<void> }) {
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
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label="项目菜单" title="项目菜单" className={cn(ICON_BUTTON, "data-[state=open]:bg-zinc-950/[0.06]")}>
            <EllipsisVertical className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem
            disabled={deleteBlocked}
            onSelect={() => {
              setDeleteError(null);
              setDeleteOpen(true);
            }}
            className="items-start gap-2 text-red-600 focus:bg-red-50 focus:text-red-700"
          >
            <Trash2 className="mt-0.5 size-4 text-current" />
            <span className="flex min-w-0 flex-col">
              <span>删除项目</span>
              {deleteBlocked && <span className="text-xs text-zinc-500">正在构建，停止后才能删除</span>}
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={deleteOpen} onOpenChange={(open) => !open && !deleting && setDeleteOpen(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除项目？</AlertDialogTitle>
            <AlertDialogDescription>删除后对话、版本和应用数据都会清除，无法恢复。</AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && (
            <p role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
              {deleteError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            <Button type="button" variant="destructive" onClick={handleDelete} disabled={deleting} aria-busy={deleting}>
              {deleting && <LoaderCircle className="size-3.5 animate-spin" />}
              {deleting ? "删除中…" : "删除"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

interface HeaderProps {
  projectName: string;
  deleteBlocked: boolean;
  onBack: () => void;
  onDelete: () => Promise<void>;
}

/** Left-column header on wide screens: back, project name, menu. */
export function ProjectHeader({ projectName, deleteBlocked, onBack, onDelete, className }: HeaderProps & { className?: string }) {
  return (
    <header className={cn("h-14 shrink-0 items-center gap-1.5 border-b border-zinc-950/[0.06] bg-white px-2.5", className)}>
      <BackButton onBack={onBack} />
      <h1 className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-tight text-zinc-900">{projectName}</h1>
      <ProjectMenu deleteBlocked={deleteBlocked} onDelete={onDelete} />
    </header>
  );
}

const TABS: { key: WorkbenchTab; label: string }[] = [
  { key: "chat", label: "对话" },
  { key: "preview", label: "预览" },
];

/**
 * Narrow-screen top bar (<1024px, ux §3): back, name, the 对话/预览 tabs and
 * the menu share one row so the conversation keeps its height.
 */
export function WorkbenchTopBar({
  projectName,
  deleteBlocked,
  onBack,
  onDelete,
  tab,
  onTabChange,
  previewLive,
  className,
}: HeaderProps & {
  tab: WorkbenchTab;
  onTabChange: (tab: WorkbenchTab) => void;
  /** Build running: dot on the 预览 tab so the change is discoverable. */
  previewLive: boolean;
  className?: string;
}) {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next = tab === "chat" ? "preview" : "chat";
    onTabChange(next);
    document.getElementById(`wb-tab-${next}`)?.focus();
  };

  return (
    <header className={cn("flex h-14 shrink-0 items-center gap-1.5 border-b border-zinc-950/[0.06] bg-white px-2", className)}>
      <BackButton onBack={onBack} />
      <h1 className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-tight text-zinc-900">{projectName}</h1>
      <div
        role="tablist"
        aria-label="工作台视图"
        onKeyDown={handleKeyDown}
        className="relative grid shrink-0 grid-cols-2 rounded-[10px] bg-zinc-100 p-0.5 ring-1 ring-zinc-950/[0.04] ring-inset"
      >
        <span
          aria-hidden="true"
          className={cn(
            "absolute inset-y-0.5 left-0.5 w-[calc(50%-2px)] rounded-lg bg-white shadow-[0_1px_2px_rgb(24_24_27/0.08),0_0_0_1px_rgb(24_24_27/0.04)] transition-transform duration-150 ease-out",
            tab === "preview" && "translate-x-full",
          )}
        />
        {TABS.map((item) => {
          const selected = tab === item.key;
          return (
            <button
              key={item.key}
              id={`wb-tab-${item.key}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`wb-panel-${item.key}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => onTabChange(item.key)}
              className={cn(
                "relative z-10 flex h-7 items-center justify-center gap-1.5 rounded-lg px-3.5 text-[13px] transition-colors duration-150",
                selected ? "font-medium text-zinc-900" : "text-zinc-500 hover:text-zinc-800",
              )}
            >
              {item.label}
              {item.key === "preview" && previewLive && (
                <span className="live-dot size-1.5 rounded-full bg-indigo-500" aria-label="正在构建" role="img" />
              )}
            </button>
          );
        })}
      </div>
      <ProjectMenu deleteBlocked={deleteBlocked} onDelete={onDelete} />
    </header>
  );
}
