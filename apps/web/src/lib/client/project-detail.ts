import type { ProjectDetail } from "@min-atoms/protocol";

// 首页卡片悬停时投机预取工作台数据（ux §5：鼠标悬停卡片时预取项目数据）。
// 最多保留一个预取槽位：loadProjectDetail 命中时消费一次即清空；
// 投机请求的失败被吞掉，load 时识别并回退为正常请求，
// 避免未处理的 Promise 拒绝卡住后续加载。槽位超过 PREFETCH_TTL_MS 视为
// 过期，不会把陈旧数据当成缓存一直返回。

const PREFETCH_TTL_MS = 30_000;

interface PrefetchSlot {
  projectId: string;
  startedAt: number;
  promise: Promise<ProjectDetail>;
}

let slot: PrefetchSlot | null = null;

async function fetchProjectDetail(projectId: string): Promise<ProjectDetail> {
  const response = await fetch(`/api/projects/${projectId}`, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`加载项目失败：HTTP ${response.status}`);
  }
  return (await response.json()) as ProjectDetail;
}

/** 悬停投机预取：同 id 不重复请求；换卡片时替换旧槽位。 */
export function prefetchProjectDetail(projectId: string): void {
  if (slot?.projectId === projectId) return;
  const promise = fetchProjectDetail(projectId);
  // 投机失败在这里吞掉；真正消费时由 loadProjectDetail 识别并重试。
  promise.catch(() => undefined);
  slot = { projectId, startedAt: Date.now(), promise };
}

/**
 * 加载项目详情：命中未过期的预取槽位则消费其结果（仅一次），
 * 预取失败或没有预取时发起正常请求，错误抛给调用方。
 */
export async function loadProjectDetail(
  projectId: string,
): Promise<ProjectDetail> {
  const current = slot;
  if (
    current &&
    current.projectId === projectId &&
    Date.now() - current.startedAt <= PREFETCH_TTL_MS
  ) {
    slot = null;
    try {
      return await current.promise;
    } catch {
      // 投机请求失败：回退到正常请求，把错误抛给调用方。
      return fetchProjectDetail(projectId);
    }
  }
  return fetchProjectDetail(projectId);
}
