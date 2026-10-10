"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ProjectSummary } from "@min-atoms/protocol";
import { Loader2, MoreHorizontal, Trash2 } from "lucide-react";

import { cardAccentStyle } from "@/components/home/card-accent";
import { formatRelativeTime } from "@/components/home/format-relative-time";
import { USE_MOCK_HOME } from "@/components/home/mock-projects";
import { prefetchProjectDetail } from "@/lib/client/project-detail";
import { cn } from "@/lib/utils";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

function statusLine(project: ProjectSummary) {
  if (project.hasRunningRun) {
    return (
      <span className="inline-flex items-center gap-1.5 font-medium text-indigo-600">
        <span aria-hidden="true" className="live-dot size-1.5 rounded-full bg-indigo-500" />
        构建中
      </span>
    );
  }
  if (project.latestVersionNumber !== null) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <span className="rounded-md bg-zinc-100 px-1.5 font-mono text-[11px] leading-[18px] font-medium text-zinc-600">
          v{project.latestVersionNumber}
        </span>
        <span className="truncate">{formatRelativeTime(project.updatedAt)}</span>
      </span>
    );
  }
  return <span>未完成</span>;
}

export function ProjectCard({
  onDeleted,
  project,
}: {
  onDeleted: (projectId: string) => void;
  project: ProjectSummary;
}) {
  const router = useRouter();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [imageFailed, setImageFailed] = useState(false);

  const showScreenshot = project.currentScreenshotSha !== null && !imageFailed;

  async function confirmDelete() {
    if (isDeleting) return;
    setDeleteError(null);
    setIsDeleting(true);
    try {
      if (!USE_MOCK_HOME) {
        const response = await fetch(`/api/projects/${project.id}`, {
          method: "DELETE",
        });
        if (!response.ok) {
          setDeleteError(
            response.status === 409
              ? "正在构建，停止后才能删除"
              : "删除失败，请重试",
          );
          return;
        }
      } else {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      setDialogOpen(false);
      onDeleted(project.id);
    } catch {
      setDeleteError("删除失败，请重试");
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <div
      className="group relative"
      onMouseEnter={() => {
        router.prefetch(`/p/${project.id}`);
        if (!USE_MOCK_HOME) prefetchProjectDetail(project.id);
      }}
    >
      <Link
        className={cn(
          "block overflow-hidden rounded-2xl bg-white transition-[box-shadow,transform] duration-150 ease-out hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.99] motion-reduce:hover:translate-y-0",
          // Same language as the live preview frame: running = indigo ring.
          // (Ternary, not an override: tailwind-merge can't dedupe var() shadows.)
          project.hasRunningRun
            ? "shadow-[0_0_0_1.5px_rgb(99_102_241/0.55),0_8px_24px_-12px_rgb(67_56_202/0.3)] hover:shadow-[0_0_0_1.5px_rgb(99_102_241/0.7),0_14px_30px_-12px_rgb(67_56_202/0.35)]"
            : "shadow-[var(--shadow-card)] hover:shadow-[var(--shadow-raised)]",
        )}
        href={`/p/${project.id}`}
      >
        <div className="relative aspect-[16/9] overflow-hidden bg-zinc-100 sm:aspect-[16/10]">
          {showScreenshot ? (
            // 截图经 web 的代理路由提供，不直接暴露预览主机名。
            // eslint-disable-next-line @next/next/no-img-element
            <img
              alt=""
              className="size-full object-cover object-top"
              onError={() => setImageFailed(true)}
              src={`/api/projects/${project.id}/shots/${project.currentScreenshotSha}`}
            />
          ) : (
            <div
              aria-hidden="true"
              className="relative flex size-full items-center justify-center"
              style={cardAccentStyle(project.id)}
            >
              <div className="mat-texture" />
              <span className="relative text-4xl font-semibold tracking-tight">
                {project.name.trim().charAt(0) || "?"}
              </span>
            </div>
          )}
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 shadow-[inset_0_-1px_0_rgb(24_24_27/0.06)]" />
        </div>
        <div className="px-4 py-3">
          <p className="truncate text-sm font-medium text-zinc-900">{project.name}</p>
          <p className="mt-1 flex h-[18px] items-center text-xs text-zinc-500">{statusLine(project)}</p>
        </div>
      </Link>
      <div className="absolute top-2.5 right-2.5 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100 has-[[data-state=open]]:opacity-100 [@media(hover:hover)]:opacity-0">
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={`${project.name} 更多操作`}
            className="press flex size-8 items-center justify-center rounded-lg bg-white/90 text-zinc-500 shadow-[var(--shadow-card)] backdrop-blur hover:text-zinc-900 data-[state=open]:text-zinc-900"
          >
            <MoreHorizontal aria-hidden="true" className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem
              className="items-start gap-2 text-red-600 focus:bg-red-50 focus:text-red-700"
              disabled={project.hasRunningRun}
              onSelect={() => {
                setDeleteError(null);
                setDialogOpen(true);
              }}
            >
              <Trash2 aria-hidden="true" className="mt-0.5 size-4 text-current" />
              <span className="flex min-w-0 flex-col">
                <span>删除</span>
                {project.hasRunningRun ? (
                  <span className="text-xs text-zinc-500">正在构建，停止后才能删除</span>
                ) : null}
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <AlertDialog onOpenChange={setDialogOpen} open={dialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除「{project.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              删除后对话、版本和应用数据都会清除，无法恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError ? (
            <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
              {deleteError}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-xl" disabled={isDeleting}>
              取消
            </AlertDialogCancel>
            <Button
              aria-busy={isDeleting}
              className="rounded-xl"
              disabled={isDeleting}
              onClick={() => void confirmDelete()}
              type="button"
              variant="destructive"
            >
              {isDeleting ? (
                <>
                  <Loader2 aria-hidden="true" className="animate-spin" />
                  删除中…
                </>
              ) : (
                "删除"
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
