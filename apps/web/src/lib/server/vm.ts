import type { VmStatus } from "../runtime";
import { getControllerStatus } from "./controller";
import { getManagerClient } from "./manager";

/** Cache the complete health/controller result for 10 s (architecture §10). */
export const VM_STATUS_CACHE_MS = 10_000;
let cache: { key: string; value: VmStatus; expiresAt: number } | undefined;

export async function getVmStatus(now = Date.now()): Promise<VmStatus> {
  const key = `${process.env.MANAGER_URL ?? ""}\n${process.env.CONTROLLER_URL ?? ""}\n${process.env.CONTROLLER_TOKEN ?? ""}`;
  if (cache?.key === key && cache.expiresAt > now) return cache.value;
  let up = false;
  try {
    up = await getManagerClient().health();
  } catch {
    // An unconfigured or unreachable manager still permits controller wake-up.
  }
  const value: VmStatus = up ? { up: true, phase: "running" } : { up: false, ...await getControllerStatus() };
  cache = { key, value, expiresAt: now + VM_STATUS_CACHE_MS };
  return value;
}

export async function isVmUp(now = Date.now()): Promise<boolean> {
  return (await getVmStatus(now)).up;
}

export function invalidateVmCache(): void {
  cache = undefined;
}

export const resetVmCacheForTests = invalidateVmCache;
