"use client";

import { useLayoutEffect, useRef } from "react";
import { ArrowDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cancelledNote, type LocalDraft, type RunViewData, type TimelineItem, type WorkbenchState } from "@/lib/client/store";
import { cn } from "@/lib/utils";

import { AtomAvatar } from "./atom-avatar";
import { RunBlock } from "./run-block";
import { VersionCard } from "./version-card";

export interface MessageActions {
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

function UserBubble({ content, mode, failed, sending }: { content: string; mode: "chat" | "build"; failed?: boolean; sending?: boolean }) {
  return (
    <div className="flex justify-end">
      <div
        className={cn(
          "relative max-w-[85%] rounded-2xl px-3.5 py-2 text-[15px] leading-[1.6] break-words whitespace-pre-wrap",
          failed ? "border border-red-300 bg-red-50 text-red-700" : "bg-zinc-200/70 text-zinc-800",
          sending && "opacity-70",
        )}
      >
        {mode === "chat" && (
          <span className="absolute -top-2 left-2 rounded-full border border-zinc-200 bg-white px-1.5 text-[10px] leading-4 text-zinc-500">
            讨论
          </span>
        )}
        {content}
      </div>
    </div>
  );
}

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
      <div ref={containerRef} onScroll={handleScroll} className="h-full space-y-5 overflow-y-auto px-4 py-4">
        {timeline.map((item) => {
          if (item.type === "user") {
            return <UserBubble key={item.key} content={item.message.content} mode={item.message.mode} />;
          }
          if (item.type === "draft") {
            const draft: LocalDraft = item.draft;
            return (
              <div key={item.key} className="space-y-1.5">
                <UserBubble content={draft.content} mode={draft.mode} failed={draft.state === "failed"} sending={draft.state === "sending"} />
                {draft.state === "failed" && (
                  <div className="flex items-center justify-end gap-2 text-xs text-red-600">
                    <span>发送失败</span>
                    <button type="button" className="font-medium text-indigo-600 hover:underline" onClick={() => actions.onRetryDraft(draft.tempId)}>
                      重试
                    </button>
                  </div>
                )}
              </div>
            );
          }
          if (item.type === "note") {
            const version = item.version;
            return (
              <div key={item.key} className="flex gap-3">
                <AtomAvatar />
                <div className="min-w-0 flex-1 space-y-2.5">
                  <p className="pt-1.5 text-xs text-zinc-500">{item.message.content}</p>
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
              currentVersionId={state.currentVersionId}
              restoreBlocked={restoreBlocked}
              onRestoreRequest={actions.onRestoreRequest}
              onFix={actions.onFix}
              onRetryRun={actions.onRetryRun}
            />
          );
        })}
      </div>
      <Button
        ref={jumpButtonRef}
        type="button"
        size="sm"
        variant="outline"
        onClick={handleJumpToBottom}
        className="wb-hidden absolute right-4 bottom-3 z-10 rounded-full bg-white shadow-md"
      >
        <ArrowDown className="size-3.5" />
        新消息
      </Button>
    </div>
  );
}
