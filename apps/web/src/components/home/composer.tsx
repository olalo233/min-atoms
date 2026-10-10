"use client";

import { KeyboardEvent, RefObject, useEffect } from "react";
import { ArrowUp, CircleAlert, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

const LINE_HEIGHT = 24; // leading-6
const VERTICAL_PADDING = 20; // pt-4 + pb-1
const MIN_HEIGHT = 3 * LINE_HEIGHT + VERTICAL_PADDING;
const MAX_HEIGHT = 8 * LINE_HEIGHT + VERTICAL_PADDING;

export function Composer({
  error,
  isSubmitting,
  onChange,
  onFocus,
  onSubmit,
  textareaRef,
  value,
}: {
  error: string | null;
  isSubmitting: boolean;
  onChange: (value: string) => void;
  onFocus?: () => void;
  onSubmit: (value: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
}) {
  // 3–8 行自动增高，超出后内部滚动。
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const next = Math.min(Math.max(textarea.scrollHeight, MIN_HEIGHT), MAX_HEIGHT);
    textarea.style.height = `${next}px`;
    textarea.style.overflowY = textarea.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
  }, [textareaRef, value]);

  const canSend = value.trim().length > 0 && !isSubmitting;

  function submit() {
    const prompt = value.trim();
    if (!prompt || isSubmitting) return;
    onSubmit(prompt);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter 发送，Shift+Enter 换行；输入法组字（isComposing）时 Enter 不发送。
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    submit();
  }

  return (
    <div>
      <div
        className={cn(
          "rounded-[20px] bg-white text-left transition-shadow duration-150",
          error
            ? "shadow-[0_0_0_1px_rgb(220_38_38/0.5),0_12px_28px_-12px_rgb(24_24_27/0.18)]"
            : "shadow-[var(--shadow-raised)] focus-within:shadow-[0_0_0_1px_rgb(99_102_241/0.65),0_0_0_5px_rgb(99_102_241/0.12),0_16px_36px_-16px_rgb(67_56_202/0.35)]",
        )}
      >
        <textarea
          aria-describedby={error ? "home-composer-error" : undefined}
          aria-invalid={error ? true : undefined}
          aria-label="描述你想做的应用"
          className="block w-full resize-none rounded-t-[20px] bg-transparent px-4 pt-4 pb-1 text-base leading-6 text-zinc-900 outline-none placeholder:text-zinc-400 sm:px-5 sm:text-[15px] focus-visible:outline-none"
          onChange={(event) => onChange(event.target.value)}
          onFocus={onFocus}
          onKeyDown={handleKeyDown}
          placeholder="例如：做一个记账本，按月统计支出…"
          ref={textareaRef}
          rows={3}
          style={{ minHeight: MIN_HEIGHT, maxHeight: MAX_HEIGHT }}
          value={value}
        />
        <div className="flex items-center justify-between gap-3 px-3 pb-3 sm:px-4">
          <p className="hidden pl-1 text-xs text-zinc-400 sm:block">
            <kbd className="font-sans">Enter</kbd> 发送 · <kbd className="font-sans">Shift + Enter</kbd> 换行
          </p>
          <button
            aria-busy={isSubmitting}
            aria-label="发送"
            className={cn(
              "press ml-auto flex size-9 shrink-0 items-center justify-center rounded-full",
              canSend || isSubmitting
                ? "bg-indigo-600 text-white shadow-[0_1px_2px_rgb(67_56_202/0.35),inset_0_1px_0_rgb(255_255_255/0.15)] hover:bg-indigo-500"
                : "bg-zinc-100 text-zinc-400",
            )}
            disabled={!canSend}
            onClick={submit}
            type="button"
          >
            {isSubmitting ? (
              <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            ) : (
              <ArrowUp aria-hidden="true" className="size-[18px]" strokeWidth={2.25} />
            )}
          </button>
        </div>
      </div>
      {error ? (
        <p className="mt-2.5 flex items-center justify-center gap-1.5 text-sm text-red-600" id="home-composer-error" role="alert">
          <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
          {error}
        </p>
      ) : null}
    </div>
  );
}
