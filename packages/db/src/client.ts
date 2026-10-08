import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Options } from "postgres";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;

// Callers supply the appropriate transaction (web) or session (manager) pool URL.
export function createDatabase(databaseUrl: string, options: Options<Record<string, never>> = {}) {
  if (!databaseUrl) throw new Error("DATABASE_URL is required to access the database.");
  const client = postgres(databaseUrl, { max: 5, ...options, prepare: false });
  const db = drizzle(client, { schema });
  return { db, close: () => client.end({ timeout: 1 }) };
}

export type DatabaseConnection = ReturnType<typeof createDatabase>;
