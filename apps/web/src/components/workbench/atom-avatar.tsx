import { Atom } from "lucide-react";

import { cn } from "@/lib/utils";

/** "Atom · 工程师" avatar: indigo gradient circle with the Atom icon (ux §2). */
export function AtomAvatar({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-indigo-700 text-white",
        className,
      )}
    >
      <Atom className="size-4" />
    </span>
  );
}
