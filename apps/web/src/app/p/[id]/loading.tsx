import { WorkbenchSkeleton } from "@/components/workbench/workbench-skeleton";

// ux §5/§7.1：路由切换期间显示与首页提交过渡态一致的工作台骨架。
export default function ProjectWorkbenchLoading() {
  return <WorkbenchSkeleton />;
}
