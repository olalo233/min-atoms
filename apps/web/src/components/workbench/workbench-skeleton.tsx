import { LoaderCircle } from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";

// 工作台骨架（ux §6.1）：/p/[id] 的 loading.tsx、工作台自身加载态和首页
// 提交过渡态共用。版式与真实工作台逐块对齐（顶栏、对话、输入框、预览台），
// 切换时不跳。独立成小组件，首页引用时不会把工作台的 client/store 栈打进
// 首页 bundle；这里直接引入 workbench.css，保证 .wb-root 等样式在首页过渡态
// 同样生效，不依赖先访问或预取过项目路由。
import "../../app/p/workbench.css";

function WakingLabel({ className }: { className?: string }) {
  return (
    <p className={className}>
      <LoaderCircle className="size-3.5 animate-spin text-indigo-500" aria-hidden="true" />
      正在唤醒应用…
    </p>
  );
}

export function WorkbenchSkeleton() {
  return (
    <div className="wb-root flex h-dvh flex-col overflow-hidden bg-white" aria-busy="true" aria-label="正在打开工作台">
      {/* Narrow top bar: back · name · tabs · menu */}
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-zinc-950/[0.06] px-3 lg:hidden">
        <Skeleton className="size-6 rounded-lg" />
        <Skeleton className="h-4 w-28 rounded-md" />
        <div className="flex-1" />
        <Skeleton className="h-8 w-[104px] rounded-[10px]" />
        <Skeleton className="size-6 rounded-lg" />
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex w-full min-w-0 flex-col lg:w-[35%] lg:max-w-[560px] lg:min-w-[380px] lg:shrink-0 lg:border-r lg:border-zinc-950/[0.07]">
          <div className="hidden h-14 shrink-0 items-center gap-2.5 border-b border-zinc-950/[0.06] px-3.5 lg:flex">
            <Skeleton className="size-6 rounded-lg" />
            <Skeleton className="h-4 w-32 rounded-md" />
          </div>
          <div className="mx-auto min-h-0 w-full max-w-[720px] flex-1 space-y-6 overflow-hidden px-4 pt-5 sm:px-5">
            <div className="flex justify-end pl-12">
              <Skeleton className="h-16 w-4/5 max-w-80 rounded-[18px] rounded-br-md" />
            </div>
            <div className="flex gap-3">
              <Skeleton className="size-7 shrink-0 rounded-full" />
              <div className="min-w-0 flex-1 space-y-3">
                <Skeleton className="h-4 w-24 rounded-md" />
                <div className="space-y-2.5 rounded-xl p-3 shadow-[var(--shadow-card)]">
                  <Skeleton className="h-3.5 w-1/3 rounded-md" />
                  <Skeleton className="h-3.5 w-3/5 rounded-md" />
                  <Skeleton className="h-3.5 w-1/2 rounded-md" />
                </div>
                <WakingLabel className="flex items-center gap-1.5 text-[13px] text-zinc-500 lg:hidden" />
              </div>
            </div>
          </div>
          <div className="shrink-0 px-3 pt-1 pb-3 sm:px-4 sm:pb-4">
            <div className="mx-auto h-[100px] max-w-[720px] rounded-[18px] p-3 shadow-[var(--shadow-raised)]">
              <Skeleton className="h-4 w-3/5 rounded-md" />
              <div className="mt-[42px] flex items-center justify-between">
                <Skeleton className="h-7 w-28 rounded-[10px]" />
                <Skeleton className="size-8 rounded-full" />
              </div>
            </div>
          </div>
        </div>
        <div className="hidden min-w-0 flex-1 flex-col bg-zinc-100 lg:flex">
          <div className="flex h-14 shrink-0 items-center gap-2 border-b border-zinc-950/[0.06] bg-white px-3">
            <Skeleton className="h-4 w-16 rounded-md" />
            <div className="flex-1" />
            <Skeleton className="size-6 rounded-lg" />
            <Skeleton className="size-6 rounded-lg" />
            <Skeleton className="h-8 w-20 rounded-xl" />
          </div>
          <div className="bench-mat min-h-0 flex-1 p-4">
            <div className="wb-frame flex h-full flex-col overflow-hidden rounded-xl bg-white">
              <div className="flex flex-1 flex-col gap-3 p-8">
                <Skeleton className="h-7 w-2/5 rounded-lg" />
                <Skeleton className="h-4 w-3/5 rounded-md" />
                <Skeleton className="mt-2 h-11 w-full rounded-xl" />
                <div className="grid min-h-0 flex-1 grid-cols-2 gap-3">
                  <Skeleton className="rounded-xl" />
                  <Skeleton className="rounded-xl" />
                </div>
              </div>
              <WakingLabel className="flex items-center justify-center gap-2 border-t border-zinc-950/[0.05] py-3 text-[13px] text-zinc-500" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
