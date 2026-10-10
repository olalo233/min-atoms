"use client";

import type { RunViewData, TimelineItem, WorkbenchState } from "@/lib/client/store";
import type { RunMode } from "@/lib/client/source";
import { cn } from "@/lib/utils";

import { Composer } from "./composer";
import { MessageList, type MessageActions } from "./message-list";
import { ProjectHeader } from "./project-header";

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

/**
 * Left column (ux §6.1): header (wide screens only; narrow screens use the
 * top bar), scrollable conversation, composer pinned to the bottom.
 */
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
  return (
    <section
      id="wb-panel-chat"
      aria-label="对话"
      className={cn(
        "min-h-0 w-full min-w-0 flex-col bg-white lg:w-[35%] lg:max-w-[560px] lg:min-w-[380px] lg:shrink-0 lg:border-r lg:border-zinc-950/[0.07]",
        className,
      )}
    >
      <ProjectHeader
        className="hidden lg:flex"
        projectName={state.projectName}
        deleteBlocked={deleteBlocked}
        onBack={onBack}
        onDelete={onDelete}
      />
      <MessageList state={state} timeline={timeline} restoreBlocked={restoreBlocked} sendSignal={sendSignal} actions={actions} />
      <Composer activeRun={activeRun} onSend={onSend} onStop={onStop} />
    </section>
  );
}
