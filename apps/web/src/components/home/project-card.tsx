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
    return <span className="font-medium text-indigo-600">● 构建中</span>;
  }
  if (project.latestVersionNumber !== null) {
    return (
      <span>
        v{project.latestVersionNumber} · {formatRelativeTime(project.updatedAt)}
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
        className="block rounded-2xl border border-zinc-200 bg-white shadow-sm transition hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
        href={`/p/${project.id}`}
      >
        <div className="aspect-[16/10] overflow-hidden rounded-t-2xl">
          {showScreenshot ? (
            // 截图经 web 的代理路由提供，不直接暴露预览主机名。
            // eslint-disable-next-line @next/next/no-img-element
            <img
              alt=""
              className="size-full object-cover"
              onError={() => setImageFailed(true)}
              src={`/api/projects/${project.id}/shots/${project.currentScreenshotSha}`}
            />
          ) : (
            <div
              aria-hidden="true"
              className="flex size-full items-center justify-center text-3xl font-semibold"
              style={cardAccentStyle(project.id)}
            >
              {project.name.trim().charAt(0) || "?"}
            </div>
          )}
        </div>
        <div className="border-t border-zinc-100 px-4 py-3">
          <p className="truncate text-sm font-medium text-zinc-900">
            {project.name}
          </p>
          <p className="mt-0.5 text-xs text-zinc-500">{statusLine(project)}</p>
        </div>
      </Link>
      <div className="absolute right-2 top-2">
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={`${project.name} 更多操作`}
            className="flex size-8 items-center justify-center rounded-xl border border-zinc-200 bg-white/90 text-zinc-500 shadow-sm transition hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 data-[state=open]:text-zinc-900"
          >
            <MoreHorizontal aria-hidden="true" className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem
              className="gap-2 text-red-600 focus:text-red-600"
              disabled={project.hasRunningRun}
              onSelect={() => {
                setDeleteError(null);
                setDialogOpen(true);
              }}
            >
              <Trash2 aria-hidden="true" className="size-4" />
              <span>删除</span>
              {project.hasRunningRun ? (
                <span className="ml-auto text-xs text-zinc-400">
                  正在构建，停止后才能删除
                </span>
              ) : null}
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
            <p className="text-sm text-red-600" role="alert">
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
