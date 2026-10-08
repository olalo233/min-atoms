"use client";

import { useState, type KeyboardEvent } from "react";
import { ArrowUp, LoaderCircle, Square } from "lucide-react";

import type { RunMode } from "@/lib/client/source";
import type { RunViewData } from "@/lib/client/store";
import { cn } from "@/lib/utils";

interface ComposerProps {
  activeRun: RunViewData | undefined;
  onSend: (content: string, mode: RunMode) => void;
  onStop: (runId: string) => void;
}

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
    <div className="shrink-0 border-t border-zinc-200 bg-white p-3">
      <div className="rounded-2xl border border-zinc-200 bg-white shadow-sm transition-colors focus-within:border-indigo-400">
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={2}
          className="max-h-48 min-h-11 w-full resize-none overflow-y-auto field-sizing-content rounded-t-2xl bg-transparent px-3.5 py-2.5 text-[15px] leading-[1.6] outline-none placeholder:text-zinc-400"
        />
        <div className="flex items-center justify-between px-2.5 pb-2.5">
          <div className="flex rounded-xl bg-zinc-100 p-0.5 text-xs" role="group" aria-label="消息模式">
            {(["build", "chat"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setMode(value)}
                aria-pressed={mode === value}
                className={cn(
                  "rounded-[10px] px-2.5 py-1 transition-colors duration-150",
                  mode === value ? "bg-white font-medium text-zinc-900 shadow-sm" : "text-zinc-500 hover:text-zinc-700",
                )}
              >
                {value === "build" ? "构建" : "讨论"}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            {activeRun && (
              <button
                type="button"
                onClick={() => onStop(activeRun.id)}
                disabled={stopDisabled}
                title={activeRun.phase === "committing" ? "正在保存版本，马上完成" : "停止"}
                className="flex size-8 items-center justify-center rounded-full bg-zinc-900 text-white transition-opacity disabled:opacity-40"
              >
                {stopRequested ? <LoaderCircle className="size-4 animate-spin" /> : <Square className="size-3 fill-current" />}
              </button>
            )}
            <button
              type="button"
              onClick={send}
              disabled={!canSend}
              title="发送"
              className="flex size-8 items-center justify-center rounded-xl bg-indigo-600 text-white transition-opacity disabled:opacity-40"
            >
              <ArrowUp className="size-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
