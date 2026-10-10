"use client";

import { useState, type KeyboardEvent } from "react";
import { ArrowUp, Hammer, LoaderCircle, MessageCircle, Square } from "lucide-react";

import type { RunMode } from "@/lib/client/source";
import type { RunViewData } from "@/lib/client/store";
import { cn } from "@/lib/utils";

interface ComposerProps {
  activeRun: RunViewData | undefined;
  onSend: (content: string, mode: RunMode) => void;
  onStop: (runId: string) => void;
}

const MODES: { value: RunMode; label: string; Icon: typeof Hammer }[] = [
  { value: "build", label: "构建", Icon: Hammer },
  { value: "chat", label: "讨论", Icon: MessageCircle },
];

/**
 * Workbench composer (ux §6.3): build/chat segmented control, Enter to send
 * (Shift+Enter newline, IME composition safe), stop button while running.
 */
export function Composer({ activeRun, onSend, onStop }: ComposerProps) {
  const [mode, setMode] = useState<RunMode>("build");
  const [text, setText] = useState("");

  const canSend = text.trim().length > 0;
  const stopRequested = !!activeRun?.stopRequestedAt;
  const stopDisabled = !activeRun || activeRun.phase === "committing" || stopRequested;

  const send = () => {
    if (!canSend) return;
    onSend(text.trim(), mode);
    setText("");
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Never submit a half-composed IME candidate (ux §13).
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };

  const placeholder = activeRun
    ? "AI 正在工作，新消息会在当前任务后执行"
    : mode === "build"
      ? "描述你想要的功能或修改，AI 会直接改应用"
      : "和 AI 讨论想法，不会修改应用";

  return (
    <div className="shrink-0 bg-white px-3 pt-1 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-4 sm:pb-4">
      <div
        className={cn(
          "mx-auto max-w-[720px] rounded-[18px] bg-white shadow-[var(--shadow-raised)] transition-shadow duration-150",
          "focus-within:shadow-[0_0_0_1px_rgb(99_102_241/0.6),0_0_0_4px_rgb(99_102_241/0.12),0_12px_28px_-14px_rgb(67_56_202/0.3)]",
        )}
      >
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          aria-label={mode === "build" ? "构建消息" : "讨论消息"}
          rows={2}
          className="block max-h-48 min-h-[3.25rem] w-full resize-none overflow-y-auto rounded-t-[18px] bg-transparent px-4 pt-3 pb-1 text-base leading-6 text-zinc-900 outline-none field-sizing-content placeholder:text-zinc-400 focus-visible:outline-none sm:text-[15px]"
        />
        <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5">
          <div className="relative grid grid-cols-2 rounded-[10px] bg-zinc-100 p-0.5 text-xs" role="group" aria-label="消息模式">
            <span
              aria-hidden="true"
              className={cn(
                "absolute inset-y-0.5 left-0.5 w-[calc(50%-2px)] rounded-lg bg-white shadow-[0_1px_2px_rgb(24_24_27/0.08),0_0_0_1px_rgb(24_24_27/0.04)] transition-transform duration-150 ease-out",
                mode === "chat" && "translate-x-full",
              )}
            />
            {MODES.map(({ value, label, Icon }) => (
              <button
                key={value}
                type="button"
                onClick={() => setMode(value)}
                aria-pressed={mode === value}
                className={cn(
                  "relative z-10 flex h-7 items-center justify-center gap-1 rounded-lg px-2.5 transition-colors duration-150",
                  mode === value ? "font-medium text-zinc-900" : "text-zinc-500 hover:text-zinc-800",
                )}
              >
                <Icon className={cn("size-3.5", mode === value && value === "build" && "text-indigo-600")} aria-hidden="true" />
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            {activeRun && (
              <button
                type="button"
                onClick={() => onStop(activeRun.id)}
                disabled={stopDisabled}
                aria-label={stopRequested ? "正在停止" : "停止"}
                title={activeRun.phase === "committing" ? "正在保存版本，马上完成" : "停止"}
                className="press flex size-8 items-center justify-center rounded-full bg-zinc-900 text-white hover:bg-zinc-700 disabled:opacity-40"
              >
                {stopRequested ? <LoaderCircle className="size-4 animate-spin" /> : <Square className="size-3 fill-current" />}
              </button>
            )}
            <button
              type="button"
              onClick={send}
              disabled={!canSend}
              aria-label="发送"
              title="发送"
              className={cn(
                "press flex size-8 items-center justify-center rounded-full",
                canSend
                  ? "bg-indigo-600 text-white shadow-[0_1px_2px_rgb(67_56_202/0.35),inset_0_1px_0_rgb(255_255_255/0.15)] hover:bg-indigo-500"
                  : "bg-zinc-100 text-zinc-400",
              )}
            >
              <ArrowUp className="size-4" strokeWidth={2.25} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
