import type { ReactNode } from "react";
import { MessageCircle } from "lucide-react";

import type { RunMode } from "@/lib/client/source";
import { cn } from "@/lib/utils";

/** Small tag in the bubble's top-left corner ("讨论"; phase 2 adds 📍 标注). */
export function BubbleTag({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-md bg-white/80 px-1.5 text-[11px] leading-[18px] font-medium text-zinc-500 ring-1 ring-zinc-950/[0.06]">
      {icon}
      <span className="truncate">{children}</span>
    </span>
  );
}

interface UserBubbleProps {
  content: string;
  mode: RunMode;
  failed?: boolean;
  sending?: boolean;
  /** Extra tags rendered next to the mode tag (phase 2: annotation chip). */
  tags?: ReactNode;
  /** Line under the bubble (send failure + retry). */
  footer?: ReactNode;
}

/** Right-aligned user message (ux §6.2): light grey bubble, 讨论 tag for chat mode. */
export function UserBubble({ content, mode, failed, sending, tags, footer }: UserBubbleProps) {
  const hasTags = mode === "chat" || !!tags;
  return (
    <div className="flex flex-col items-end gap-1.5 pl-8 sm:pl-12">
      <div
        className={cn(
          "max-w-full min-w-0 rounded-[18px] rounded-br-md px-3.5 py-2 text-[15px] leading-[1.6] whitespace-pre-wrap [overflow-wrap:anywhere] transition-opacity duration-150",
          failed ? "bg-red-50 text-red-800 ring-1 ring-red-600/20" : "bg-zinc-100 text-zinc-800",
          sending && "opacity-60",
        )}
      >
        {hasTags && (
          <div className="-ml-0.5 mb-1 flex flex-wrap gap-1 pt-0.5">
            {mode === "chat" && <BubbleTag icon={<MessageCircle className="size-3" />}>讨论</BubbleTag>}
            {tags}
          </div>
        )}
        {content}
      </div>
      {footer}
    </div>
  );
}
