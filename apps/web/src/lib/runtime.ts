/** Web-local mirror of the approved controller contract. */
export const RUNTIME_PHASES = [
  "running", "starting", "stopping", "stopped", "retiring", "retired", "restoring", "unavailable", "error",
] as const;
export type RuntimePhase = (typeof RUNTIME_PHASES)[number];
export type RuntimeStatus = { phase: RuntimePhase; detail?: string };
export type VmStatus = RuntimeStatus & { up: boolean };

export function runtimeCopy(phase: RuntimePhase | null, detail?: string, up = false) {
  switch (phase) {
    case "stopped":
    case "starting":
      return { title: "正在启动运行环境", body: "预计约 1 分钟，准备好后会自动连接。", line: "运行环境启动中，约 1 分钟" };
    case "retired":
    case "restoring":
      return { title: "正在恢复运行环境", body: "闲置时已释放环境以节省费用，\n预计 2–4 分钟恢复。", line: "运行环境恢复中，约 2–4 分钟" };
    case "stopping":
    case "retiring":
      return { title: "运行环境休眠中", body: "正在完成休眠，稍后会自动重新启动。", line: "运行环境休眠中，稍后自动重新启动" };
    case "error":
      return { title: "运行环境暂时无法启动", body: detail || "暂时无法启动，请重试。", line: "运行环境暂时无法启动" };
    case "unavailable":
      return { title: "运行环境暂时无法启动", body: detail || "连接暂时不可用，请稍后重试。", line: "运行环境暂时无法连接" };
    case "running":
      return { title: up ? "正在准备应用" : "正在连接运行环境", body: up ? "运行环境已就绪，正在连接预览。" : "运行环境已启动，服务准备预计约 1 分钟。", line: up ? "运行环境已就绪，正在准备应用预览" : "运行环境正在准备，约 1 分钟" };
    default:
      return { title: "正在检查运行环境", body: "请稍候，正在确认运行环境的状态。", line: "运行环境检查中" };
  }
}
