import { createDatabase } from "@min-atoms/db";
import { createManager, type KickQueuedProject } from "./manager";
import { createManagerStore } from "./store";
import { installRunDriver } from "./run-driver";
import { createRestoreStore, installRestore } from "./restore";

export function readManagerConfig(env: Record<string, string | undefined>) {
  for (const key of ["DATABASE_URL", "MA_SHARED_SECRET", "WEB_ORIGIN"]) {
    if (!env[key]?.trim()) throw new Error(`${key} is required`);
  }
  if ((env.PORT !== undefined && env.PORT !== "8090") || (env.HOST !== undefined && env.HOST !== "127.0.0.1")) {
    throw new Error("Manager must bind 127.0.0.1:8090");
  }
  let origin: URL;
  let database: URL;
  try { origin = new URL(env.WEB_ORIGIN!); database = new URL(env.DATABASE_URL!); }
  catch { throw new Error("Invalid WEB_ORIGIN or DATABASE_URL"); }
  if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== env.WEB_ORIGIN) throw new Error("WEB_ORIGIN must be an exact HTTP origin");
  if (!["postgres:", "postgresql:"].includes(database.protocol) || (database.port && database.port !== "5432")) {
    throw new Error("DATABASE_URL must use the manager session pool on port 5432");
  }
  return { databaseUrl: env.DATABASE_URL!, secret: env.MA_SHARED_SECRET!, webOrigin: env.WEB_ORIGIN! };
}

export type QueueDriverFactory = (manager: ReturnType<typeof createManager>) => KickQueuedProject;

// Called by the entrypoint, or by T12 with a driver bound to these exact
// runtime/event/store instances. Imports are inert.
export async function startManager(config: ReturnType<typeof readManagerConfig>, installQueue: QueueDriverFactory = installRunDriver) {
  const connection = createDatabase(config.databaseUrl);
  try {
    const manager = createManager({ ...config, store: createManagerStore(connection.db) });
    installRestore(manager, { store: createRestoreStore(connection.db) });
    const recovery = await manager.initialize(installQueue(manager));
    return { ...manager, recovery, close: connection.close };
  } catch (error) { await connection.close(); throw error; }
}

if (import.meta.main) {
  const manager = await startManager(readManagerConfig(process.env));
  Bun.serve({ hostname: "127.0.0.1", port: 8090, idleTimeout: 0, fetch: manager.app.fetch });
}
