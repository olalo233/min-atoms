"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
        setError(
          response.status === 401
            ? "用户名或密码错误"
            : "登录失败，请稍后重试",
        );
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
      className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm"
      onSubmit={handleSubmit}
    >
      {error ? (
        <p className="mb-4 text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}
      <div className="space-y-4">
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-zinc-900" htmlFor="username">
            用户名
          </label>
          <Input
            autoComplete="username"
            autoFocus
            className="h-11 rounded-2xl"
            id="username"
            name="username"
            onChange={(event) => setUsername(event.target.value)}
            required
            value={username}
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-zinc-900" htmlFor="password">
            密码
          </label>
          <Input
            autoComplete="current-password"
            className="h-11 rounded-2xl"
            id="password"
            name="password"
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
        </div>
      </div>
      <Button
        aria-busy={isSubmitting}
        className="mt-6 h-11 w-full rounded-xl font-semibold"
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
      <p className="mt-4 text-center text-xs text-zinc-400">
        演示账号见邀请信息
      </p>
    </form>
  );
}
