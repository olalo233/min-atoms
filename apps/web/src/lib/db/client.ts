import { createDatabase, type DatabaseConnection } from "@min-atoms/db";

const globalForDatabase = globalThis as unknown as {
  databaseConnection?: DatabaseConnection;
};

export function getDb() {
  if (!globalForDatabase.databaseConnection) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required to access the database.");
    }
    globalForDatabase.databaseConnection = createDatabase(databaseUrl);
  }
  return globalForDatabase.databaseConnection.db;
}

export async function closeDatabase(): Promise<void> {
  await globalForDatabase.databaseConnection?.close();
  globalForDatabase.databaseConnection = undefined;
}
