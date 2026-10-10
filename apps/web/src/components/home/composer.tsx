"use client";

import { KeyboardEvent, RefObject, useEffect } from "react";
import { ArrowUp, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";

const LINE_HEIGHT = 24; // text-[15px] * leading-[1.6]
const VERTICAL_PADDING = 32; // pt-4 + 输入框内底部留白
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
      <div className="rounded-2xl border border-zinc-200 bg-white shadow-sm transition focus-within:border-indigo-600 focus-within:ring-2 focus-within:ring-indigo-600/15">
        <textarea
          aria-label="描述你想做的应用"
          className="block w-full resize-none rounded-t-2xl bg-transparent px-4 pt-4 text-[15px] leading-[1.6] text-zinc-900 outline-none placeholder:text-zinc-400"
          onChange={(event) => onChange(event.target.value)}
          onFocus={onFocus}
          onKeyDown={handleKeyDown}
          placeholder="例如：做一个记账本，按月统计支出…"
          ref={textareaRef}
          rows={3}
          style={{ minHeight: MIN_HEIGHT, maxHeight: MAX_HEIGHT }}
          value={value}
        />
        <div className="flex items-center justify-end px-3 pb-3">
          <Button
            aria-busy={isSubmitting}
            aria-label="发送"
            className="size-9 rounded-full"
            disabled={!value.trim() || isSubmitting}
            onClick={submit}
            size="icon"
            type="button"
          >
            {isSubmitting ? (
              <Loader2 aria-hidden="true" className="animate-spin" />
            ) : (
              <ArrowUp aria-hidden="true" />
            )}
          </Button>
        </div>
      </div>
      {error ? (
        <p className="mt-2 text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
