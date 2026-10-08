import type { ProjectSummary } from "@min-atoms/protocol";

// 仅开发预览使用：development 构建且 NEXT_PUBLIC_MOCK_STREAM=1 时首页用虚构数据
// 渲染，便于在 T10（项目 API）和 T14（截图）就绪前验收界面。不包含任何真实数据。
// 生产构建（NODE_ENV=production）永远走真实接口，不跳过真实操作。
export const USE_MOCK_HOME =
  process.env.NODE_ENV === "development" &&
  process.env.NEXT_PUBLIC_MOCK_STREAM === "1";

export const MOCK_CREATED_PROJECT_ID = "00000000-0000-4000-8000-0000000000d1";

const now = Date.now();

export const MOCK_PROJECTS: ProjectSummary[] = [
  {
    id: "00000000-0000-4000-8000-0000000000a1",
    name: "程序员计算器",
    updatedAt: new Date(now - 2 * 60_000).toISOString(),
    hasRunningRun: false,
    latestVersionNumber: 3,
    currentScreenshotSha: null,
  },
  {
    id: "00000000-0000-4000-8000-0000000000a2",
    name: "贪吃蛇小游戏",
    updatedAt: new Date(now - 30 * 60_000).toISOString(),
    hasRunningRun: true,
    latestVersionNumber: null,
    currentScreenshotSha: null,
  },
  {
    id: "00000000-0000-4000-8000-0000000000a3",
    name: "待办清单",
    updatedAt: new Date(now - 26 * 3_600_000).toISOString(),
    hasRunningRun: false,
    latestVersionNumber: 1,
    currentScreenshotSha: null,
  },
];
