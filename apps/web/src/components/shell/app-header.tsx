"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronDown, Loader2, LogOut } from "lucide-react";
import { toast } from "sonner";

import { BrandMark, Wordmark } from "@/components/shell/brand-mark";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function AppHeader({ username }: { username: string }) {
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  async function handleLogout() {
    if (isLoggingOut) return;
    setIsLoggingOut(true);
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) {
        toast.error("退出失败，请重试");
        return;
      }
      // End the session with a new document so prefetched private data is discarded.
      window.location.assign("/login");
    } catch {
      toast.error("退出失败，请重试");
    } finally {
      setIsLoggingOut(false);
    }
  }

  const initial = username.trim().charAt(0).toUpperCase() || "?";

  return (
    <header className="sticky top-0 z-30 border-b border-zinc-950/[0.06] bg-zinc-50/80 backdrop-blur-md">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
        <Link aria-label="min-atoms 首页" className="flex min-w-0 items-center gap-2 rounded-xl" href="/">
          <BrandMark />
          <Wordmark />
        </Link>
        <DropdownMenu>
          <DropdownMenuTrigger
            className="press flex min-w-0 items-center gap-2 rounded-full py-1 pr-2 pl-1 text-sm text-zinc-700 hover:bg-zinc-950/[0.05] data-[state=open]:bg-zinc-950/[0.06]"
            aria-label={`账号菜单：${username}`}
          >
            <span
              aria-hidden="true"
              className="flex size-7 shrink-0 items-center justify-center rounded-full bg-zinc-900 font-mono text-xs font-semibold text-white"
            >
              {initial}
            </span>
            <span className="max-w-32 truncate sm:max-w-40">{username}</span>
            <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-zinc-400" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel className="truncate text-xs font-normal text-zinc-500">已登录为 {username}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="gap-2"
              disabled={isLoggingOut}
              onSelect={(event) => {
                event.preventDefault();
                void handleLogout();
              }}
            >
              {isLoggingOut ? (
                <Loader2 aria-hidden="true" className="size-4 animate-spin" />
              ) : (
                <LogOut aria-hidden="true" className="size-4" />
              )}
              {isLoggingOut ? "退出中…" : "退出"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
