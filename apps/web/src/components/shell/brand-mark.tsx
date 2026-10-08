import { Atom } from "lucide-react";

import { cn } from "@/lib/utils";

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
        "inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-indigo-700 text-white",
        className,
      )}
    >
      <Atom className={cn("size-4", iconClassName)} />
    </span>
  );
}
