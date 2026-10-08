"use client";

import { Atom, ExternalLink, RefreshCw } from "lucide-react";
import type { VersionDTO } from "@min-atoms/protocol";

import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import { VersionMenu } from "./version-menu";

interface PreviewPaneProps {
  className?: string;
  vmUp: boolean | null;
  previewUrl: string | null;
  previewReady: boolean;
  previewKey: number;
  running: boolean;
  versions: VersionDTO[];
  currentVersionId: string | null;
  restoreBlocked: boolean;
  onRefresh: () => void;
  onRestoreRequest: (version: VersionDTO) => void;
}

const IFRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads";

/**
 * Preview pane (ux §6.4/§8). The iframe src is assigned once and is never
 * rewritten by polling, events, or new versions; the refresh button remounts
 * it via key. While the environment is down or the container wakes, an
 * overlay covers the (kept-alive) iframe so nothing reloads.
 */
export function PreviewPane({
  className,
  vmUp,
  previewUrl,
  previewReady,
  previewKey,
  running,
  versions,
  currentVersionId,
  restoreBlocked,
  onRefresh,
  onRestoreRequest,
}: PreviewPaneProps) {
  const envDown = vmUp === false;
  const showIframe = previewUrl !== null && previewReady && !envDown;

  return (
    <section className={cn("min-h-0 min-w-0 flex-1 flex-col", className)}>
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-zinc-200 bg-white px-3">
        <span className="flex h-12 items-center border-b-2 border-indigo-600 px-1 text-sm font-medium text-zinc-900">应用预览</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onRefresh}
          disabled={!showIframe}
          title="刷新预览"
          className="flex size-8 items-center justify-center rounded-xl text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 disabled:opacity-40"
        >
          <RefreshCw className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => previewUrl && window.open(previewUrl, "_blank", "noopener,noreferrer")}
          disabled={!showIframe}
          title="在新标签页打开"
          className="flex size-8 items-center justify-center rounded-xl text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 disabled:opacity-40"
        >
          <ExternalLink className="size-4" />
        </button>
        <VersionMenu versions={versions} currentVersionId={currentVersionId} restoreBlocked={restoreBlocked} onRestoreRequest={onRestoreRequest} />
        {running && (
          <span className="ml-1 flex items-center gap-1.5 rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-600">
            <span className="wb-shimmer size-1.5 rounded-full bg-indigo-600" />
            正在构建
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 p-3">
        <div
          className={cn(
            "relative h-full w-full overflow-hidden rounded-2xl border bg-white",
            running && showIframe ? "wb-preview-active border-indigo-500" : "border-zinc-200",
          )}
        >
          {previewUrl && (
            <iframe
              key={previewKey}
              src={previewUrl}
              title="应用预览"
              sandbox={IFRAME_SANDBOX}
              allow="clipboard-write"
              className={cn("h-full w-full", !showIframe && "invisible")}
            />
          )}
          {envDown ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-zinc-50 px-6 text-center">
              <span className="flex size-14 items-center justify-center rounded-full bg-zinc-200/70 text-zinc-400">
                <Atom className="size-7" />
              </span>
              <p className="text-sm font-medium text-zinc-700">演示环境未启动</p>
              <p className="text-xs text-zinc-500">环境启动后，排队中的任务会自动开始</p>
            </div>
          ) : (
            !showIframe && (
              <div className="absolute inset-0 flex flex-col gap-3 bg-white p-4">
                <Skeleton className="h-8 w-2/3 rounded-xl" />
                <Skeleton className="h-4 w-1/2 rounded-lg" />
                <Skeleton className="min-h-0 flex-1 rounded-xl" />
                <p className="pb-2 text-center text-xs text-zinc-500">
                  {vmUp === null ? "正在检查演示环境…" : "正在唤醒应用…"}
                </p>
              </div>
            )
          )}
        </div>
      </div>
    </section>
  );
}
