"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronRight, FilePen, FileText, Folder, LoaderCircle, Search, Terminal, Wrench, X } from "lucide-react";

import { limitLines } from "@/lib/client/format";
import type { ToolStep } from "@/lib/client/store";
import { cn } from "@/lib/utils";

/** Tool icon per ux §9, keyed off the tool name with title fallback. */
function toolIcon(step: ToolStep) {
  const key = `${step.name} ${step.title}`;
  if (/读|读取|read/i.test(key)) return FileText;
  if (/编辑|创建|写|write|edit/i.test(key)) return FilePen;
  if (/运行|执行|run|exec|bash|command/i.test(key)) return Terminal;
  if (/搜索|查找|search|grep|find/i.test(key)) return Search;
  if (/查看|列|list|ls\b/i.test(key)) return Folder;
  return Wrench;
}

function statusIcon(step: ToolStep) {
  if (step.status === "running") return <LoaderCircle className="size-3.5 shrink-0 animate-spin text-indigo-600" />;
  if (step.status === "failed") return <X className="size-3.5 shrink-0 text-red-600" />;
  return <Check className="size-3.5 shrink-0 text-zinc-400" />;
}

const VISIBLE_WHILE_RUNNING = 6;

/**
 * Collapsible "工作过程" list (ux §6.2): expanded while running with the
 * latest steps visible; folds to a single summary line when the run ends.
 */
export function StepList({ steps, running, durationText }: { steps: ToolStep[]; running: boolean; durationText: string | null }) {
  const [expanded, setExpanded] = useState(running);
  const wasRunningRef = useRef(running);

  // ux 6.2: expand when a queued run starts, collapse to the summary line
  // when the run reaches a terminal state. Only the transition overrides the
  // user: explicit toggles made afterward are kept.
  useEffect(() => {
    if (wasRunningRef.current === running) return;
    wasRunningRef.current = running;
    setExpanded(running);
  }, [running]);
  const [showOlder, setShowOlder] = useState(false);
  const [openSteps, setOpenSteps] = useState<ReadonlySet<string>>(new Set());

  const toggleStep = (toolCallId: string) => {
    setOpenSteps((previous) => {
      const next = new Set(previous);
      if (next.has(toolCallId)) next.delete(toolCallId);
      else next.add(toolCallId);
      return next;
    });
  };

  const hiddenCount = running && !showOlder ? Math.max(0, steps.length - VISIBLE_WHILE_RUNNING) : 0;
  const visibleSteps = hiddenCount > 0 ? steps.slice(-VISIBLE_WHILE_RUNNING) : steps;
  const meta = [`已处理 ${steps.length} 步`, !running && durationText ? `用时 ${durationText}` : null].filter(Boolean).join(" · ");

  return (
    <div className="rounded-xl border border-zinc-200 bg-white text-sm">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left"
        aria-expanded={expanded}
      >
        <ChevronRight className={cn("size-3.5 shrink-0 text-zinc-400 transition-transform duration-150", expanded && "rotate-90")} />
        <span className="font-medium text-zinc-700">工作过程</span>
        <span className="ml-auto shrink-0 text-xs text-zinc-400">{meta}</span>
      </button>
      {expanded && (
        <ul className="border-t border-zinc-100 py-1">
          {hiddenCount > 0 && (
            <li>
              <button
                type="button"
                onClick={() => setShowOlder(true)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-400 hover:text-zinc-600"
              >
                更早的 {hiddenCount} 步
              </button>
            </li>
          )}
          {visibleSteps.map((step) => {
            const ToolIcon = toolIcon(step);
            const open = openSteps.has(step.toolCallId);
            return (
              <li key={step.toolCallId}>
                <button
                  type="button"
                  disabled={!step.summary}
                  onClick={() => toggleStep(step.toolCallId)}
                  className={cn("flex w-full items-center gap-2 px-3 py-1.5 text-left", step.summary && "hover:bg-zinc-50")}
                  aria-expanded={step.summary ? open : undefined}
                >
                  {statusIcon(step)}
                  <ToolIcon className="size-3.5 shrink-0 text-zinc-400" />
                  <span className={cn("min-w-0 flex-1 truncate", step.status === "failed" ? "text-red-600" : "text-zinc-700")}>{step.title}</span>
                </button>
                {open && step.summary && (
                  <pre className="mx-3 mb-2 max-h-52 overflow-auto rounded-lg bg-zinc-50 p-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-zinc-600">
                    {limitLines(step.summary, 10)}
                  </pre>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
