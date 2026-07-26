import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "@/db/schema";

type Database = PostgresJsDatabase<typeof schema>;

const globalForDatabase = globalThis as unknown as {
  postgresClient?: ReturnType<typeof postgres>;
  database?: Database;
};

function getDatabase(): Database {
  if (globalForDatabase.database) {
    return globalForDatabase.database;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to access the database.");
  }

  const client = postgres(databaseUrl, {
    max: 5,
    prepare: false,
  });
  const database = drizzle(client, { schema });

  globalForDatabase.postgresClient = client;
  globalForDatabase.database = database;

  return database;
}

export function getDb(): Database {
  return getDatabase();
}

export async function closeDatabase(): Promise<void> {
  if (globalForDatabase.postgresClient) {
    await globalForDatabase.postgresClient.end({ timeout: 1 });
    globalForDatabase.postgresClient = undefined;
    globalForDatabase.database = undefined;
  }
}
