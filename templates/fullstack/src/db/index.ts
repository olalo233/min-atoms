import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";

// App data lives in a single SQLite file. In production the container sets
// DATABASE_PATH=/data/app.db; locally it falls back to ./data/app.db.
const databasePath = process.env.DATABASE_PATH ?? "data/app.db";
mkdirSync(dirname(databasePath), { recursive: true });

const sqlite = new Database(databasePath, { create: true });
sqlite.exec("PRAGMA journal_mode = WAL;");
sqlite.exec("PRAGMA foreign_keys = ON;");

export const db = drizzle(sqlite, { schema });
