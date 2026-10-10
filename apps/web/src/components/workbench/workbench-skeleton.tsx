import { Skeleton } from "@/components/ui/skeleton";

// 工作台骨架（ux §6.1）：/p/[id] 的 loading.tsx、工作台自身加载态和首页
// 提交过渡态共用。独立成小组件，首页引用时不会把工作台的 client/store
// 栈打进首页 bundle；这里直接引入 workbench.css，保证 .wb-root 等样式在
// 首页过渡态同样生效，不依赖先访问或预取过项目路由。
import "../../app/p/workbench.css";

export function WorkbenchSkeleton() {
  return (
    <div className="wb-root flex h-dvh overflow-hidden bg-zinc-100">
      <div className="hidden w-[35%] min-w-[380px] flex-col gap-4 border-r border-zinc-200 bg-zinc-50 p-4 lg:flex">
        <Skeleton className="h-8 w-1/2 rounded-xl" />
        <Skeleton className="h-16 w-3/4 self-end rounded-2xl" />
        <Skeleton className="h-40 w-full rounded-2xl" />
        <Skeleton className="h-24 w-full rounded-2xl" />
      </div>
      <div className="flex flex-1 flex-col gap-3 p-3">
        <Skeleton className="min-h-0 flex-1 rounded-2xl" />
        <p className="pb-1 text-center text-xs text-zinc-500">
          正在唤醒应用…
        </p>
      </div>
    </div>
  );
}
