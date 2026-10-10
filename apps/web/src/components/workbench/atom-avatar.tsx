import { Atom } from "lucide-react";

import { cn } from "@/lib/utils";

import { AGENT_TONES, type AgentTone } from "./agent-identity";

/** Agent avatar: gradient circle with the lucide Atom icon (ux §2). */
export function AtomAvatar({ className, tone = "indigo" }: { className?: string; tone?: AgentTone }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br text-white ring-1 ring-white/20 ring-inset",
        AGENT_TONES[tone].avatar,
        className,
      )}
    >
      <Atom className="size-4" strokeWidth={2.25} />
    </span>
  );
}
