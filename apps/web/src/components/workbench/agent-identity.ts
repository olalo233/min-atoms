/**
 * Who is speaking in a run block. Today there is a single agent
 * ("Atom · 工程师", indigo, ux §2). Phase 2 (p3.md §7.2) maps PM / designer /
 * engineer onto these tones; the avatar, rail dots and dispatch rows read
 * their colours from AGENT_TONES so adding a role is a data change.
 */
export type AgentTone = "indigo" | "violet" | "emerald";

export interface AgentIdentity {
  name: string;
  role: string;
  tone: AgentTone;
}

export const AGENT_TONES: Record<AgentTone, { avatar: string; dot: string; text: string }> = {
  indigo: {
    avatar: "from-indigo-500 to-indigo-700 shadow-[0_1px_2px_rgb(67_56_202/0.35)]",
    dot: "bg-indigo-500",
    text: "text-indigo-700",
  },
  violet: {
    avatar: "from-violet-500 to-violet-700 shadow-[0_1px_2px_rgb(109_40_217/0.35)]",
    dot: "bg-violet-500",
    text: "text-violet-700",
  },
  emerald: {
    avatar: "from-emerald-500 to-emerald-700 shadow-[0_1px_2px_rgb(4_120_87/0.35)]",
    dot: "bg-emerald-500",
    text: "text-emerald-700",
  },
};

export const DEFAULT_AGENT: AgentIdentity = { name: "Atom", role: "工程师", tone: "indigo" };
