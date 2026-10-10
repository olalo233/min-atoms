"use client";

import { Atom, ExternalLink, LoaderCircle, RefreshCw } from "lucide-react";
import type { VersionDTO } from "@min-atoms/protocol";

import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import { ICON_BUTTON } from "./project-header";
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

/** "● 正在构建" pill (ux §6.1). */
function LivePill() {
  return (
    <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-indigo-50 py-1 pr-2.5 pl-2 text-xs font-medium text-indigo-700 ring-1 ring-indigo-500/15">
      <span aria-hidden="true" className="live-dot size-1.5 rounded-full bg-indigo-500" />
      正在构建
    </span>
  );
}

/**
 * Preview pane (ux §6.4/§8). The iframe src is assigned once and is never
 * rewritten by polling, events, or new versions; the refresh button remounts
 * it via key. While the environment is down or the container wakes, an
 * overlay covers the (kept-alive) iframe so nothing reloads. The pane is
 * hidden with CSS on narrow screens, never unmounted, for the same reason.
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
  const live = running && showIframe;

  return (
    <section id="wb-panel-preview" aria-label="应用预览" className={cn("min-h-0 min-w-0 flex-1 flex-col bg-zinc-100", className)}>
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-zinc-950/[0.06] bg-white px-2 sm:px-3 lg:h-14">
        {/* ux §6.1: a single "应用预览" tab. Narrow screens already show it in the top bar. */}
        <span className="mr-2 hidden h-full items-center border-b-2 border-indigo-600 px-1 pt-0.5 text-sm font-medium text-zinc-900 lg:flex">
          应用预览
        </span>
        {running && <LivePill />}
        <div className="min-w-0 flex-1" />
        {/* Phase 2: the 标注 toggle (≥1024px) goes here, before refresh. */}
        <button type="button" onClick={onRefresh} disabled={!showIframe} aria-label="刷新预览" title="刷新预览" className={ICON_BUTTON}>
          <RefreshCw className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => previewUrl && window.open(previewUrl, "_blank", "noopener,noreferrer")}
          disabled={!showIframe}
          aria-label="在新标签页打开"
          title="在新标签页打开"
          className={ICON_BUTTON}
        >
          <ExternalLink className="size-4" />
        </button>
        <span aria-hidden="true" className="mx-1 h-5 w-px bg-zinc-950/[0.08]" />
        <VersionMenu versions={versions} currentVersionId={currentVersionId} restoreBlocked={restoreBlocked} onRestoreRequest={onRestoreRequest} />
      </div>
      <div className="bench-mat min-h-0 flex-1 p-2 sm:p-3 lg:p-4">
        <div className={cn("wb-frame relative h-full w-full overflow-hidden rounded-xl bg-white", live && "wb-frame-live")}>
          {previewUrl && (
            <iframe
              key={previewKey}
              src={previewUrl}
              title="应用预览"
              sandbox={IFRAME_SANDBOX}
              allow="clipboard-write"
              className={cn("block h-full w-full", !showIframe && "invisible")}
            />
          )}
          {/* Rendered after the iframe so toggling it never touches the iframe node. */}
          {live && <div aria-hidden="true" className="wb-progress" />}
          {envDown ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-zinc-50 px-6 text-center">
              <span className="flex size-14 items-center justify-center rounded-2xl bg-white text-zinc-400 shadow-[var(--shadow-card)]">
                <Atom className="size-7" />
              </span>
              <p className="mt-1 text-[15px] font-semibold text-zinc-800">演示环境未启动</p>
              <p className="max-w-xs text-[13px] text-zinc-500">环境启动后，排队中的任务会自动开始</p>
            </div>
          ) : (
            !showIframe && (
              <div className="absolute inset-0 flex flex-col bg-white" aria-busy="true">
                <div className="flex flex-1 flex-col gap-3 p-5 sm:p-8">
                  <Skeleton className="h-7 w-2/5 rounded-lg" />
                  <Skeleton className="h-4 w-3/5 rounded-md" />
                  <Skeleton className="mt-2 h-11 w-full rounded-xl" />
                  <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 sm:grid-cols-2">
                    <Skeleton className="min-h-16 rounded-xl" />
                    <Skeleton className="hidden min-h-16 rounded-xl sm:block" />
                  </div>
                </div>
                <p className="flex items-center justify-center gap-2 border-t border-zinc-950/[0.05] py-3 text-[13px] text-zinc-500">
                  <LoaderCircle className="size-3.5 animate-spin text-indigo-500" aria-hidden="true" />
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
