import { redirect } from "next/navigation";

// 旧地址，统一跳回首页（首页自己处理未登录跳转）。
export default function WorkspacePage() {
  redirect("/");
}
