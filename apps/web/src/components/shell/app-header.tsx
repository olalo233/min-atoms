"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronDown, LogOut } from "lucide-react";
import { toast } from "sonner";

import { BrandMark } from "@/components/shell/brand-mark";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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

  return (
    <header className="border-b border-zinc-200 bg-white">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-6">
        <Link
          aria-label="min-atoms 首页"
          className="flex items-center gap-2 rounded-xl focus-visible:outline-none"
          href="/"
        >
          <BrandMark />
          <span className="text-sm font-semibold tracking-tight text-zinc-900">
            min-atoms
          </span>
        </Link>
        <DropdownMenu>
          <DropdownMenuTrigger
            className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-sm text-zinc-700 transition hover:bg-zinc-100 focus-visible:outline-none data-[state=open]:bg-zinc-100"
            aria-label="账号菜单"
          >
            <span className="max-w-40 truncate">{username}</span>
            <ChevronDown aria-hidden="true" className="size-4 text-zinc-400" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem
              className="gap-2"
              disabled={isLoggingOut}
              onSelect={(event) => {
                event.preventDefault();
                void handleLogout();
              }}
            >
              <LogOut aria-hidden="true" className="size-4" />
              {isLoggingOut ? "退出中…" : "退出"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
