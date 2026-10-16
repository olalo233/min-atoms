import { RUNTIME_PHASES, type RuntimeStatus } from "../runtime";

const TIMEOUT_MS = 5_000;
const WAKE_DEDUPE_MS = 15_000;
let wakeCache: { key: string; expiresAt: number; result: Promise<RuntimeStatus> } | undefined;

/** Server-only adapter: configuration and controller errors never reach the browser. */
async function requestController(path: "/status" | "/wake"): Promise<RuntimeStatus> {
  const url = process.env.CONTROLLER_URL;
  const token = process.env.CONTROLLER_TOKEN;
  if (!url || !token) return { phase: "unavailable", detail: "自动启动暂不可用，请稍后重试。" };
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${url.replace(/\/+$/, "")}${path}`, {
      method: path === "/wake" ? "POST" : "GET",
      headers: { authorization: `Bearer ${token}` },
      signal: abort.signal,
      cache: "no-store",
    });
    if (!response.ok) throw new Error("Controller unavailable");
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || !("phase" in body) || !RUNTIME_PHASES.some((phase) => phase === body.phase)) {
      throw new Error("Invalid controller response");
    }
    const detail = "detail" in body && typeof body.detail === "string" ? body.detail : undefined;
    return { phase: body.phase as RuntimeStatus["phase"], ...(detail ? { detail } : {}) };
  } catch {
    return { phase: "unavailable", detail: "暂时无法连接启动服务，请稍后重试。" };
  } finally {
    clearTimeout(timer);
  }
}

export const getControllerStatus = () => requestController("/status");

export function wakeRuntime(now = Date.now()): Promise<RuntimeStatus> {
  const key = `${process.env.CONTROLLER_URL ?? ""}\n${process.env.CONTROLLER_TOKEN ?? ""}`;
  if (wakeCache?.key === key && wakeCache.expiresAt > now) return wakeCache.result;
  const result = requestController("/wake");
  wakeCache = { key, expiresAt: now + WAKE_DEDUPE_MS, result };
  return result;
}

export function resetControllerCacheForTests() {
  wakeCache = undefined;
}
