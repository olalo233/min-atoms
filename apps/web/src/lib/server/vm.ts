import { getManagerClient } from "./manager";

/** /api/vm caches the manager health probe for 10 s (architecture.md §10). */
export const VM_STATUS_CACHE_MS = 10_000;

type CacheEntry = { key: string; value: boolean; expiresAt: number };

let cache: CacheEntry | undefined;

export async function isVmUp(now: number = Date.now()): Promise<boolean> {
  const key = process.env.MANAGER_URL ?? "";
  if (cache && cache.key === key && cache.expiresAt > now) {
    return cache.value;
  }

  let value = false;
  try {
    value = await getManagerClient().health();
  } catch {
    value = false;
  }

  cache = { key, value, expiresAt: now + VM_STATUS_CACHE_MS };
  return value;
}

export function resetVmCacheForTests(): void {
  cache = undefined;
}
