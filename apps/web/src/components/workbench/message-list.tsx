"use client";

import { useLayoutEffect, useRef } from "react";
import { ArrowDown, RotateCw } from "lucide-react";

import { cancelledNote, type RunViewData, type TimelineItem, type WorkbenchState } from "@/lib/client/store";

import { AtomAvatar } from "./atom-avatar";
import { RunBlock } from "./run-block";
import { UserBubble } from "./user-bubble";
import { VersionCard } from "./version-card";

export interface MessageActions {
  onRuntimeRetry: () => void;
  onRetryDraft: (tempId: string) => void;
  onFix: () => void;
  onRetryRun: (run: RunViewData) => void;
  onRestoreRequest: (versionId: string) => void;
}

interface MessageListProps {
  state: WorkbenchState;
  timeline: TimelineItem[];
  restoreBlocked: boolean;
  /** Bumped when the user sends a message: always scroll back to bottom. */
  sendSignal: number;
  actions: MessageActions;
}

const NEAR_BOTTOM_PX = 80;

export function MessageList({ state, timeline, restoreBlocked, sendSignal, actions }: MessageListProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const jumpButtonRef = useRef<HTMLButtonElement | null>(null);
  const pinnedRef = useRef(true);
  const jumpedOnceRef = useRef(false);
  const lastSendSignalRef = useRef(sendSignal);

  // Bottom-aware scrolling (ux §6.2/§6.3): auto-scroll only while the user
  // stays near the bottom; otherwise surface the "↓ 新消息" jump button.
  // Streamed updates never steal upward browsing, but the user's own send
  // (sendSignal) always re-pins and jumps to the bottom. Scroll state is
  // driven through DOM classes so no re-render is needed on scroll.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (sendSignal !== lastSendSignalRef.current) {
      lastSendSignalRef.current = sendSignal;
      pinnedRef.current = true;
      jumpButtonRef.current?.classList.add("wb-hidden");
    }
    if (!jumpedOnceRef.current) {
      // Entering the workbench lands at the bottom without animation.
      jumpedOnceRef.current = true;
      container.scrollTop = container.scrollHeight;
      return;
    }
    if (pinnedRef.current) {
      container.scrollTop = container.scrollHeight;
    } else {
      jumpButtonRef.current?.classList.remove("wb-hidden");
    }
  }, [timeline, sendSignal]);

  const handleScroll = () => {
    const container = containerRef.current;
    if (!container) return;
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight <= NEAR_BOTTOM_PX;
    pinnedRef.current = nearBottom;
    if (nearBottom) jumpButtonRef.current?.classList.add("wb-hidden");
  };

  const handleJumpToBottom = () => {
    const container = containerRef.current;
    if (!container) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    container.scrollTo({ top: container.scrollHeight, behavior: reduceMotion ? "auto" : "smooth" });
    pinnedRef.current = true;
    jumpButtonRef.current?.classList.add("wb-hidden");
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={containerRef}
        onScroll={handleScroll}
        role="log"
        aria-label="对话记录"
        aria-live="off"
        className="h-full overflow-x-hidden overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
      >
        <div className="mx-auto w-full max-w-[720px] space-y-6 px-4 pt-5 pb-6 sm:px-5">
          {timeline.map((item) => {
            if (item.type === "user") {
              return <UserBubble key={item.key} content={item.message.content} mode={item.message.mode} />;
            }
            if (item.type === "draft") {
              const draft = item.draft;
              return (
                <UserBubble
                  key={item.key}
                  content={draft.content}
                  mode={draft.mode}
                  failed={draft.state === "failed"}
                  sending={draft.state === "sending"}
                  footer={
                    draft.state === "failed" && (
                      <div className="flex items-center gap-2 text-xs text-red-600" role="alert">
                        <span>发送失败</span>
                        <button
                          type="button"
                          className="press inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-indigo-600 hover:bg-indigo-50"
                          onClick={() => actions.onRetryDraft(draft.tempId)}
                        >
                          <RotateCw className="size-3" />
                          重试
                        </button>
                      </div>
                    )
                  }
                />
              );
            }
            if (item.type === "note") {
              const version = item.version;
              return (
                <div key={item.key} className="wb-enter flex gap-3">
                  <AtomAvatar />
                  <div className="min-w-0 flex-1 space-y-2.5">
                    <p className="pt-1 text-[13px] text-zinc-500">{item.message.content}</p>
                    {version && (
                      <VersionCard
                        number={version.number}
                        summary={version.summary}
                        isCurrent={version.id === state.currentVersionId}
                        restoreBlocked={restoreBlocked}
                        onRestore={() => actions.onRestoreRequest(version.id)}
                      />
                    )}
                  </div>
                </div>
              );
            }
            return (
              <RunBlock
                key={item.key}
                run={item.run}
                finalText={item.finalText}
                cancelledNote={cancelledNote(state, item.run)}
                vmUp={state.vmUp}
                runtimePhase={state.runtimePhase}
                runtimeDetail={state.runtimeDetail}
                runtimeWaitingSince={state.runtimeWaitingSince}
                runtimeWakePending={state.runtimeWakePending}
                onRuntimeRetry={actions.onRuntimeRetry}
                currentVersionId={state.currentVersionId}
                restoreBlocked={restoreBlocked}
                onRestoreRequest={actions.onRestoreRequest}
                onFix={actions.onFix}
                onRetryRun={actions.onRetryRun}
              />
            );
          })}
        </div>
      </div>
      {/* Soft fade where the conversation meets the composer. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-4 bg-gradient-to-t from-white to-transparent" />
      <button
        ref={jumpButtonRef}
        type="button"
        onClick={handleJumpToBottom}
        className="wb-hidden press absolute right-4 bottom-3 z-10 inline-flex items-center gap-1.5 rounded-full bg-white py-1.5 pr-3.5 pl-3 text-xs font-medium text-zinc-700 shadow-[var(--shadow-float)] hover:text-zinc-900"
      >
        <ArrowDown className="size-3.5" />
        新消息
      </button>
    </div>
  );
}
