import { redirect } from "next/navigation";

import { LoginForm } from "@/components/auth/login-form";
import { BrandMark, Wordmark } from "@/components/shell/brand-mark";
import { getCurrentUser } from "@/lib/auth/session";

// Mock mode (development only + NEXT_PUBLIC_MOCK_STREAM=1) has no database:
// skip the "already signed in" lookup so the page can be reviewed locally.
// Production builds always run the session check.
const MOCK_ENABLED = process.env.NODE_ENV === "development" && process.env.NEXT_PUBLIC_MOCK_STREAM === "1";

// 登录页主体，由 app/(auth)/login/page.tsx 渲染。
export async function LoginScreen() {
  if (!MOCK_ENABLED) {
    const user = await getCurrentUser();
    if (user) redirect("/");
  }

  return (
    <main className="relative isolate flex min-h-dvh flex-col overflow-hidden bg-zinc-50" id="main-content">
      <div aria-hidden="true" className="bench-mat-hero -z-10" />
      <div className="flex flex-1 items-center justify-center px-4 py-12 sm:py-16">
        <div className="w-full max-w-[22rem]">
          <div className="mb-8 flex flex-col items-center text-center">
            <BrandMark className="size-12 rounded-[14px]" iconClassName="size-6" />
            <h1 className="mt-5">
              <Wordmark className="text-2xl" />
            </h1>
            <p className="mt-2 text-sm text-zinc-500">说出你的想法，AI 帮你搭出能用的应用</p>
          </div>
          <LoginForm />
          <p className="mt-6 text-center text-xs text-zinc-400">演示账号见邀请信息</p>
        </div>
      </div>
    </main>
  );
}
