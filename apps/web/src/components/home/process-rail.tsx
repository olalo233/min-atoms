import { Fragment } from "react";

import { cn } from "@/lib/utils";

// ux §1：演示开场 30 秒内要让人明白的三件事，按真实顺序排成一条小轨道，
// 与工作台里的构建轨道同一套语汇：灰（输入）→ indigo（构建中）→ emerald（可用）。
const STEPS = [
  { label: "说一句话", dot: "bg-zinc-400" },
  { label: "AI 逐步构建", dot: "live-dot bg-indigo-500" },
  { label: "直接用上真实应用", dot: "bg-emerald-500" },
] as const;

export function ProcessRail({ className }: { className?: string }) {
  return (
    <ol
      aria-label="工作方式"
      className={cn(
        "mx-auto flex w-fit max-w-full flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-full bg-white/85 px-3.5 py-1.5 text-xs text-zinc-600 shadow-[var(--shadow-card)] backdrop-blur",
        className,
      )}
    >
      {STEPS.map((step, index) => (
        <Fragment key={step.label}>
          {index > 0 && <li aria-hidden="true" className="h-px w-3 bg-zinc-300 sm:w-5" />}
          <li className="flex items-center gap-1.5 whitespace-nowrap">
            <span aria-hidden="true" className={cn("size-1.5 rounded-full", step.dot)} />
            {step.label}
          </li>
        </Fragment>
      ))}
    </ol>
  );
}
