import { Atom } from "lucide-react";

import { cn } from "@/lib/utils";

/** Indigo atom tile used for the product mark (ux §2). */
export function BrandMark({
  className,
  iconClassName,
}: {
  className?: string;
  iconClassName?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-[9px] bg-gradient-to-br from-indigo-500 to-indigo-700 text-white shadow-[0_1px_2px_rgb(67_56_202/0.35),inset_0_1px_0_rgb(255_255_255/0.18)]",
        className,
      )}
    >
      <Atom className={cn("size-4", iconClassName)} strokeWidth={2.25} />
    </span>
  );
}

/** "min-atoms" set in the mono face: the product is a tool for building. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("font-mono text-[15px] font-semibold tracking-[-0.02em] text-zinc-900", className)}>
      min<span className="text-indigo-600">-</span>atoms
    </span>
  );
}
