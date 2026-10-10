"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { CircleAlert, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const FIELD_CLASS =
  "h-11 rounded-xl border-zinc-200 bg-zinc-50/70 px-3.5 text-base shadow-none transition-[background-color,border-color,box-shadow] duration-150 hover:border-zinc-300 focus-visible:border-indigo-500 focus-visible:bg-white focus-visible:ring-4 focus-visible:ring-indigo-500/15 md:text-[15px]";

export function LoginForm() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;
    setError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      if (!response.ok) {
        // 失败时保留用户名，方便演示者直接重试。
        setError(response.status === 401 ? "用户名或密码错误" : "登录失败，请稍后重试");
        return;
      }

      router.push("/");
      router.refresh();
    } catch {
      setError("网络异常，请稍后重试");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form
      className="rounded-2xl bg-white p-6 shadow-[var(--shadow-raised)] sm:p-7"
      onSubmit={handleSubmit}
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <label className="text-[13px] font-medium text-zinc-700" htmlFor="username">
            用户名
          </label>
          <Input
            autoComplete="username"
            autoFocus
            className={FIELD_CLASS}
            id="username"
            name="username"
            onChange={(event) => setUsername(event.target.value)}
            required
            value={username}
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-[13px] font-medium text-zinc-700" htmlFor="password">
            密码
          </label>
          <Input
            autoComplete="current-password"
            className={FIELD_CLASS}
            id="password"
            name="password"
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
        </div>
      </div>
      {/* ux §4：失败时在按钮上方显示，不清空用户名。 */}
      {error ? (
        <p
          className="mt-5 flex items-center gap-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-600/10 ring-inset"
          role="alert"
        >
          <CircleAlert aria-hidden="true" className="size-4 shrink-0 text-red-600" />
          {error}
        </p>
      ) : null}
      <Button
        aria-busy={isSubmitting}
        className="mt-5 h-11 w-full rounded-xl text-[15px] font-semibold"
        disabled={isSubmitting}
        type="submit"
      >
        {isSubmitting ? (
          <>
            <Loader2 aria-hidden="true" className="animate-spin" />
            登录中…
          </>
        ) : (
          "登录"
        )}
      </Button>
    </form>
  );
}
