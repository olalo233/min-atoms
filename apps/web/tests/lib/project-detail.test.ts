import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectDetail } from "@min-atoms/protocol";

import {
  loadProjectDetail,
  prefetchProjectDetail,
} from "@/lib/client/project-detail";

function makeDetail(id: string): ProjectDetail {
  return {
    id,
    name: `项目 ${id.slice(-4)}`,
    previewLabel: `preview-${id.slice(-4)}`,
    currentVersionId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messages: [],
    runs: [],
    versions: [],
    lastEventId: 0,
  };
}

type FetchHandler = (url: string) => { status: number; body: unknown };

function stubFetch(handler: FetchHandler) {
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const { status, body } = handler(String(input));
    return new Response(JSON.stringify(body), { status });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("project-detail client seam", () => {
  it("loadProjectDetail 在无预取时直接请求 /api/projects/:id", async () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const detail = makeDetail(id);
    const fetchMock = stubFetch((url) => {
      expect(url).toBe(`/api/projects/${id}`);
      return { status: 200, body: detail };
    });

    await expect(loadProjectDetail(id)).resolves.toEqual(detail);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("预取后 load 消费同一个在途请求，只发一次 fetch", async () => {
    const id = "00000000-0000-4000-8000-000000000002";
    const detail = makeDetail(id);
    const fetchMock = stubFetch(() => ({ status: 200, body: detail }));

    prefetchProjectDetail(id);
    await expect(loadProjectDetail(id)).resolves.toEqual(detail);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("预取被消费一次后清空，再次 load 重新请求", async () => {
    const id = "00000000-0000-4000-8000-000000000003";
    const detail = makeDetail(id);
    const fetchMock = stubFetch(() => ({ status: 200, body: detail }));

    prefetchProjectDetail(id);
    await loadProjectDetail(id);
    await loadProjectDetail(id);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("预取失败不产生未处理拒绝，load 回退为正常请求并成功", async () => {
    const id = "00000000-0000-4000-8000-000000000004";
    const detail = makeDetail(id);
    let calls = 0;
    const fetchMock = stubFetch(() => {
      calls += 1;
      return calls === 1
        ? { status: 500, body: { error: "boom" } }
        : { status: 200, body: detail };
    });

    prefetchProjectDetail(id);
    await expect(loadProjectDetail(id)).resolves.toEqual(detail);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("load 失败时把 HTTP 状态错误抛给调用方", async () => {
    const id = "00000000-0000-4000-8000-000000000005";
    stubFetch(() => ({ status: 404, body: { error: "not found" } }));

    await expect(loadProjectDetail(id)).rejects.toThrow("404");
  });

  it("悬停不同卡片时替换预取槽位，同 id 不重复预取", async () => {
    const idA = "00000000-0000-4000-8000-000000000006";
    const idB = "00000000-0000-4000-8000-000000000007";
    const detailB = makeDetail(idB);
    const fetchMock = stubFetch((url) =>
      url.endsWith(idA)
        ? { status: 200, body: makeDetail(idA) }
        : { status: 200, body: detailB },
    );

    prefetchProjectDetail(idA);
    prefetchProjectDetail(idA);
    prefetchProjectDetail(idB);
    // 同 id 去重 + 替换：A 一次、B 一次。
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(loadProjectDetail(idB)).resolves.toEqual(detailB);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("超过有效期的预取槽位不会返回陈旧数据", async () => {
    vi.useFakeTimers();
    const id = "00000000-0000-4000-8000-000000000008";
    const stale = makeDetail(id);
    const fresh = { ...makeDetail(id), name: "最新数据" };
    let calls = 0;
    const fetchMock = stubFetch(() => {
      calls += 1;
      return { status: 200, body: calls === 1 ? stale : fresh };
    });

    prefetchProjectDetail(id);
    vi.setSystemTime(Date.now() + 31_000);
    await expect(loadProjectDetail(id)).resolves.toEqual(fresh);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
