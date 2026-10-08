import {
  ManagerAbortRequestSchema,
  ManagerAbortResponseSchema,
  ManagerDeleteResponseSchema,
  ManagerEnsureRequestSchema,
  ManagerEnsureResponseSchema,
  ManagerHealthResponseSchema,
  ManagerKickRequestSchema,
  ManagerKickResponseSchema,
  ManagerRestoreRequestSchema,
  ManagerRestoreResponseSchema,
  type VersionDTO,
} from "@min-atoms/protocol";

// Timeouts documented in architecture.md §10: kick returns immediately (5 s),
// /api/vm probes /health with 3 s, ensure and restore run inside the request.
export const MANAGER_TIMEOUTS = {
  health: 3_000,
  kick: 5_000,
  abort: 10_000,
  ensure: 60_000,
  restore: 60_000,
  removeProject: 60_000,
  screenshot: 15_000,
} as const;

export type ManagerFetch = (url: string, init: RequestInit) => Promise<Response>;

export type ManagerClientOptions = {
  baseUrl: string;
  secret: string;
  fetch: ManagerFetch;
};

/** A manager call that never produced a usable response (network, timeout, or non-2xx). */
export class ManagerError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "ManagerError";
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export class ManagerClient {
  readonly baseUrl: string;
  private readonly secret: string;
  private readonly fetchImpl: ManagerFetch;

  constructor(options: ManagerClientOptions) {
    this.baseUrl = trimTrailingSlash(options.baseUrl);
    this.secret = options.secret;
    this.fetchImpl = options.fetch;
  }

  /** Unauthenticated per architecture.md §10; callers treat any failure as "down". */
  async health(timeoutMs: number = MANAGER_TIMEOUTS.health): Promise<boolean> {
    try {
      return await this.request("/health", { method: "GET" }, timeoutMs, false, async (response) => {
        if (!response.ok) {
          return false;
        }
        const parsed = ManagerHealthResponseSchema.safeParse(await response.json());
        return parsed.success && parsed.data.ok;
      });
    } catch {
      return false;
    }
  }

  async ensure(projectId: string, previewLabel: string, timeoutMs: number = MANAGER_TIMEOUTS.ensure): Promise<void> {
    const body = ManagerEnsureRequestSchema.parse({ previewLabel });
    await this.sendJson(`/projects/${projectId}/ensure`, jsonRequest("POST", body), timeoutMs, ManagerEnsureResponseSchema);
  }

  async kick(projectId: string, previewLabel: string, timeoutMs: number = MANAGER_TIMEOUTS.kick): Promise<void> {
    const body = ManagerKickRequestSchema.parse({ previewLabel });
    await this.sendJson(`/projects/${projectId}/kick`, jsonRequest("POST", body), timeoutMs, ManagerKickResponseSchema);
  }

  async abort(projectId: string, runId: string, timeoutMs: number = MANAGER_TIMEOUTS.abort): Promise<void> {
    const body = ManagerAbortRequestSchema.parse({});
    await this.sendJson(
      `/projects/${projectId}/runs/${runId}/abort`,
      jsonRequest("POST", body),
      timeoutMs,
      ManagerAbortResponseSchema,
    );
  }

  async restore(projectId: string, versionId: string, timeoutMs: number = MANAGER_TIMEOUTS.restore): Promise<VersionDTO> {
    const body = ManagerRestoreRequestSchema.parse({ versionId });
    return this.sendJson(`/projects/${projectId}/restore`, jsonRequest("POST", body), timeoutMs, ManagerRestoreResponseSchema);
  }

  async removeProject(projectId: string, timeoutMs: number = MANAGER_TIMEOUTS.removeProject): Promise<void> {
    await this.sendJson(`/projects/${projectId}`, { method: "DELETE" }, timeoutMs, ManagerDeleteResponseSchema);
  }

  async screenshot(projectId: string, sha: string, timeoutMs: number = MANAGER_TIMEOUTS.screenshot): Promise<Response> {
    return this.request(
      `/projects/${projectId}/shots/${sha}.png`,
      { method: "GET" },
      timeoutMs,
      true,
      async (response) => {
        // Buffer the image inside the deadline instead of handing the route a
        // stream that could outlive it. A non-2xx keeps its status for the route
        // to map (404 -> not found, anything else -> 502) without reading a body.
        const body = response.ok ? await response.arrayBuffer() : null;
        return new Response(body, {
          status: response.status,
          headers: { "content-type": response.headers.get("content-type") ?? "image/png" },
        });
      },
    );
  }

  streamUrl(projectId: string, token: string): string {
    return `${this.baseUrl}/projects/${projectId}/stream?token=${encodeURIComponent(token)}`;
  }

  /**
   * Runs one request under a single deadline that also covers reading the body.
   * The timer is cleared only after `consume` resolves, so a manager that returns
   * headers and then stalls aborts at the timeout instead of hanging forever.
   */
  private async request<T>(
    path: string,
    init: RequestInit,
    timeoutMs: number,
    authenticated: boolean,
    consume: (response: Response) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: authenticated
          ? { ...init.headers, authorization: `Bearer ${this.secret}` }
          : init.headers,
        signal: controller.signal,
      });
      return await consume(response);
    } catch (error) {
      if (error instanceof ManagerError) {
        throw error;
      }
      const reason = error instanceof Error ? error.message : "unknown error";
      throw new ManagerError(`Manager request to ${path} failed: ${reason}`, null);
    } finally {
      clearTimeout(timer);
    }
  }

  private async sendJson<T>(
    path: string,
    init: RequestInit,
    timeoutMs: number,
    schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
    authenticated = true,
  ): Promise<T> {
    return this.request(path, init, timeoutMs, authenticated, async (response) => {
      if (!response.ok) {
        throw new ManagerError(`Manager responded with status ${response.status}.`, response.status);
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new ManagerError("Manager returned an invalid JSON body.", response.status);
      }
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        throw new ManagerError("Manager returned an unexpected response body.", response.status);
      }
      return parsed.data;
    });
  }
}

function jsonRequest(method: "POST", body: unknown): RequestInit {
  return {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  };
}

let cachedClient: ManagerClient | undefined;

/** Shared client built from MANAGER_URL and MA_SHARED_SECRET (architecture.md §2). */
export function getManagerClient(): ManagerClient {
  const baseUrl = process.env.MANAGER_URL;
  const secret = process.env.MA_SHARED_SECRET;
  if (!baseUrl || !secret) {
    throw new ManagerError("MANAGER_URL and MA_SHARED_SECRET are required to reach the manager.", null);
  }

  if (!cachedClient || cachedClient.baseUrl !== trimTrailingSlash(baseUrl)) {
    cachedClient = new ManagerClient({ baseUrl, secret, fetch: (url, init) => fetch(url, init) });
  }
  return cachedClient;
}

export function resetManagerClientForTests(): void {
  cachedClient = undefined;
}
