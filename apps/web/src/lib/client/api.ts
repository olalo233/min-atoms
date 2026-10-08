import type { MessageDTO, RunDTO, RunEvent, VersionDTO } from "@min-atoms/protocol";

import { loadProjectDetail } from "./project-detail";
import { subscribeRunEvents } from "./sse";
import type { RunMode, WorkbenchSource } from "./source";

class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    throw new ApiError(response.status, `请求失败（${response.status}）`);
  }
  return (await response.json()) as T;
}

interface StreamTokenResponse {
  token: string;
  streamUrl: string;
  previewUrl: string;
}

/** Real workbench data source, backed by the web API (architecture §10). */
export function createApiSource(projectId: string): WorkbenchSource {
  const base = `/api/projects/${encodeURIComponent(projectId)}`;
  const fetchCredentials = () => request<StreamTokenResponse>(`${base}/stream-token`);

  return {
    // Shared loader from T15: consumes the hover prefetch slot once, then
    // falls back to a normal request. Errors propagate to the caller.
    loadProject: () => loadProjectDetail(projectId),

    subscribe(after: number, onEvent: (id: number, event: RunEvent) => void) {
      let cursor = after;
      return subscribeRunEvents({
        fetchCredentials,
        getAfter: () => cursor,
        onEvent: (id, event) => {
          cursor = Math.max(cursor, id);
          onEvent(id, event);
        },
      });
    },

    getVmUp: async () => (await request<{ up: boolean }>("/api/vm")).up,

    ensure: () => request(`${base}/ensure`, { method: "POST", body: "{}" }),

    getPreviewUrl: async () => (await fetchCredentials()).previewUrl,

    sendMessage: (content: string, mode: RunMode) =>
      request<{ message: MessageDTO; run: RunDTO }>(`${base}/messages`, {
        method: "POST",
        body: JSON.stringify({ content, mode }),
      }),

    stopRun: (runId: string) => request(`${base}/runs/${encodeURIComponent(runId)}/stop`, { method: "POST", body: "{}" }),

    restoreVersion: (versionId: string) =>
      request<VersionDTO>(`${base}/versions/${encodeURIComponent(versionId)}/restore`, { method: "POST", body: "{}" }),

    deleteProject: () => request(base, { method: "DELETE" }),
  };
}
