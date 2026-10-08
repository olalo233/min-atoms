import { redirect } from "next/navigation";

import { LoginForm } from "@/components/auth/login-form";
import { BrandMark } from "@/components/shell/brand-mark";
import { getCurrentUser } from "@/lib/auth/session";

// 登录页主体。/login 由 app/(auth)/login/page.tsx 提供；
// app/login/page.tsx 是旧路由的占位，集成时删除其一即可（两者渲染完全相同）。
export async function LoginScreen() {
  const user = await getCurrentUser();
  if (user) redirect("/");

  return (
    <main
      className="grid min-h-dvh place-items-center bg-zinc-50 px-4 py-12"
      id="main-content"
    >
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <BrandMark className="size-11" iconClassName="size-6" />
          <h1 className="text-xl font-semibold tracking-tight text-zinc-900">
            min-atoms
          </h1>
          <p className="text-sm text-zinc-500">
            说出你的想法，AI 帮你搭出能用的应用
          </p>
        </div>
        <LoginForm />
      </div>
    </main>
  );
}
