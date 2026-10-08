import { existsSync } from "node:fs";
import { join } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { db } from "./index";

const migrationsFolder = join(import.meta.dir, "..", "..", "drizzle");

// Applies drizzle migrations if any have been generated yet. With an empty
// schema the drizzle/ directory does not exist and this is a no-op.
export function runMigrations() {
  if (!existsSync(join(migrationsFolder, "meta", "_journal.json"))) {
    console.log("[db] no migrations yet, skipping");
    return;
  }
  migrate(db, { migrationsFolder });
  console.log("[db] migrations applied");
}

if (import.meta.main) {
  runMigrations();
}
