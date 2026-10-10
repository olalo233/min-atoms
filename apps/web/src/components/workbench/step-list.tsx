"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Check, ChevronDown, ChevronRight, FilePen, FileText, Folder, LoaderCircle, Search, Terminal, Wrench, X } from "lucide-react";

import { limitLines } from "@/lib/client/format";
import type { ToolStep } from "@/lib/client/store";
import { cn } from "@/lib/utils";

/** Tool icon per ux §9, keyed off the tool name with title fallback. */
function ToolGlyph({ step, className }: { step: ToolStep; className: string }) {
  const key = `${step.name} ${step.title}`;
  if (/读|读取|read/i.test(key)) return <FileText className={className} aria-hidden="true" />;
  if (/编辑|创建|写|write|edit/i.test(key)) return <FilePen className={className} aria-hidden="true" />;
  if (/运行|执行|run|exec|bash|command/i.test(key)) return <Terminal className={className} aria-hidden="true" />;
  if (/搜索|查找|search|grep|find/i.test(key)) return <Search className={className} aria-hidden="true" />;
  if (/查看|列|list|ls\b/i.test(key)) return <Folder className={className} aria-hidden="true" />;
  return <Wrench className={className} aria-hidden="true" />;
}

// Titles from ux §9 are "<verb> <target>"; the target (path, command,
// pattern, tool name) is code and is set in the mono face.
const CODE_VERBS = new Set(["读取", "写入", "编辑", "运行", "搜索", "查找文件", "使用工具"]);

export function splitStepTitle(title: string): { verb: string; target: string | null } {
  const match = /^(\S+)\s+(.+)$/.exec(title.trim());
  if (match && CODE_VERBS.has(match[1])) return { verb: match[1], target: match[2] };
  return { verb: title, target: null };
}

function StepNode({ status }: { status: ToolStep["status"] }) {
  if (status === "running") {
    return (
      <span className="wb-rail-node ring-1 ring-indigo-200">
        <LoaderCircle className="size-3 animate-spin text-indigo-600" aria-label="进行中" />
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="wb-rail-node bg-red-50 ring-1 ring-red-200">
        <X className="size-2.5 text-red-600" strokeWidth={3} aria-label="失败" />
      </span>
    );
  }
  return (
    <span className="wb-rail-node bg-zinc-100 ring-1 ring-zinc-200">
      <Check className="size-2.5 text-zinc-500" strokeWidth={3} aria-label="完成" />
    </span>
  );
}

function StepRow({ step, open, onToggle }: { step: ToolStep; open: boolean; onToggle: () => void }) {
  const { verb, target } = splitStepTitle(step.title);
  const failed = step.status === "failed";
  return (
    <li className="wb-rail-item wb-enter">
      <button
        type="button"
        disabled={!step.summary}
        onClick={onToggle}
        aria-expanded={step.summary ? open : undefined}
        className={cn(
          "group/step flex w-full min-w-0 items-center gap-2.5 py-[5px] pr-3 pl-3 text-left text-[13px] disabled:cursor-default",
          step.summary && "hover:bg-zinc-950/[0.025]",
        )}
      >
        <StepNode status={step.status} />
        <ToolGlyph step={step} className={cn("size-3.5 shrink-0", failed ? "text-red-400" : "text-zinc-400")} />
        <span className={cn("min-w-0 flex-1 truncate", failed ? "text-red-700" : "text-zinc-700")}>
          {target ? (
            <>
              <span className={failed ? "text-red-600" : "text-zinc-500"}>{verb}</span>{" "}
              <span className="font-mono text-[12.5px]">{target}</span>
            </>
          ) : (
            verb
          )}
        </span>
        {step.summary && (
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 text-zinc-300 transition-transform duration-150 group-hover/step:text-zinc-500",
              open && "rotate-180",
            )}
          />
        )}
      </button>
      {open && step.summary && (
        <pre className="mr-3 mb-1.5 ml-[46px] max-h-52 overflow-auto rounded-lg bg-zinc-50 px-2.5 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-zinc-600 ring-1 ring-zinc-950/[0.05] [overflow-wrap:anywhere]">
          {limitLines(step.summary, 10)}
        </pre>
      )}
    </li>
  );
}

const VISIBLE_WHILE_RUNNING = 6;
// Rail centre: row padding (12px) + half the 16px node.
const RAIL_STYLE = { "--rail-x": "20px" } as CSSProperties;

/**
 * Collapsible "工作过程" (ux §6.2) drawn as the build rail: expanded while
 * running with the latest steps visible; folds to one summary line when the
 * run ends. Phase 2 nests a second rail under each dispatch row.
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
    <div className="overflow-hidden rounded-xl bg-white shadow-[var(--shadow-card)]">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="press flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left hover:bg-zinc-950/[0.02]"
        aria-expanded={expanded}
      >
        <ChevronRight
          aria-hidden="true"
          className={cn("size-3.5 shrink-0 text-zinc-400 transition-transform duration-150", expanded && "rotate-90")}
        />
        <span className="shrink-0 text-[13px] font-medium text-zinc-800">工作过程</span>
        <span className="min-w-0 flex-1 truncate text-right text-xs text-zinc-400 tabular-nums">{meta}</span>
      </button>
      {expanded && (
        <ol className="wb-rail border-t border-zinc-950/[0.05] py-1" style={RAIL_STYLE} aria-label="工作步骤">
          {hiddenCount > 0 && (
            <li className="wb-rail-item">
              <button
                type="button"
                onClick={() => setShowOlder(true)}
                className="flex w-full items-center gap-2.5 py-[5px] pr-3 pl-3 text-left text-xs text-zinc-400 hover:text-zinc-700"
              >
                <span className="wb-rail-node">
                  <span className="size-1 rounded-full bg-zinc-300" />
                </span>
                更早的 {hiddenCount} 步
              </button>
            </li>
          )}
          {visibleSteps.map((step) => (
            <StepRow key={step.toolCallId} step={step} open={openSteps.has(step.toolCallId)} onToggle={() => toggleStep(step.toolCallId)} />
          ))}
        </ol>
      )}
    </div>
  );
}
