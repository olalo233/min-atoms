"use client";

import { useEffect, useState } from "react";
import { Atom, LoaderCircle } from "lucide-react";

import { runtimeCopy, type RuntimePhase } from "@/lib/runtime";

export interface RuntimeWaitingProps {
  runtimePhase: RuntimePhase | null;
  runtimeDetail?: string;
  runtimeWaitingSince: number | null;
  runtimeWakePending: boolean;
  onRuntimeRetry: () => void;
}

export function RuntimeRetry({ pending, onRetry }: { pending: boolean; onRetry: () => void }) {
  return (
    <button
      type="button"
      onClick={onRetry}
      disabled={pending}
      className="press inline-flex h-9 items-center justify-center gap-1.5 rounded-xl bg-white px-4 text-[13px] font-medium text-zinc-700 shadow-[var(--shadow-card)] hover:bg-zinc-100 focus-visible:shadow-[var(--shadow-focus)] focus-visible:outline-none disabled:opacity-60"
    >
      {pending && <LoaderCircle className="size-3.5 animate-spin text-indigo-500" aria-hidden="true" />}
      {pending ? "正在重试" : "重试"}
    </button>
  );
}

function ElapsedWait({ since }: { since: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [since]);
  const seconds = since === null ? 0 : Math.max(0, Math.floor((now - since) / 1000));
  return <span className="tabular-nums">{seconds > 5 ? `已等待 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "正在准备"}</span>;
}

/** All phases share the same slots so text changes never move the glyph or retry. */
export function RuntimeWaiting({ runtimePhase, runtimeDetail, runtimeWaitingSince, runtimeWakePending, onRuntimeRetry, up }: RuntimeWaitingProps & { up: boolean }) {
  const copy = runtimeCopy(runtimePhase, runtimeDetail, up);
  const failed = runtimePhase === "error" || runtimePhase === "unavailable";
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-zinc-50 px-6">
      <div className="flex w-full max-w-xs flex-col items-center text-center">
        <span className={`flex size-14 shrink-0 items-center justify-center rounded-2xl bg-white shadow-[var(--shadow-card)] ${failed ? "text-zinc-400" : "runtime-breathe text-indigo-500/80"}`}>
          <Atom className="size-7" aria-hidden="true" />
        </span>
        <div className="mt-4 w-full" aria-live="polite" aria-atomic="true">
          <div key={`${runtimePhase}-${up}`} className="runtime-enter">
            <p className="text-[15px] leading-6 font-semibold text-zinc-800">{copy.title}</p>
            <p className={`mt-2 flex min-h-10 items-center justify-center text-[13px] leading-5 whitespace-pre-line [overflow-wrap:anywhere] ${failed ? "text-zinc-600" : "text-zinc-500"}`}>{copy.body}</p>
          </div>
        </div>
        <p className="mt-1 flex h-5 items-center gap-1.5 text-xs text-zinc-500" aria-live="off">
          {!failed && <>
            <LoaderCircle className="size-3.5 animate-spin text-indigo-500" aria-hidden="true" />
            <ElapsedWait since={runtimeWaitingSince} />
          </>}
        </p>
        <p className="mt-4 text-xs leading-5 text-zinc-400">排队中的任务会在环境就绪后自动开始</p>
        <div className="mt-4 flex h-9 items-center">
          {failed && <RuntimeRetry pending={runtimeWakePending} onRetry={onRuntimeRetry} />}
        </div>
      </div>
    </div>
  );
}
