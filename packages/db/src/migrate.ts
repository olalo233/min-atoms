import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDatabase } from "./client";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required to run migrations.");
const connection = createDatabase(databaseUrl, { max: 1 });
try {
  await migrate(connection.db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
  console.log("Database migrations applied.");
} finally {
  await connection.close();
}
