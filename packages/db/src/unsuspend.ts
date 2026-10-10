import { createDatabase } from "./client";
import { unsuspendUser } from "./demo-users";

const username = process.argv[2];
const databaseUrl = process.env.DATABASE_URL;
if (!username || !databaseUrl) throw new Error("Usage: admin:unsuspend <username> with DATABASE_URL configured.");
const connection = createDatabase(databaseUrl);
try {
  if (!await unsuspendUser(connection.db, username)) throw new Error("User not found.");
  console.log("Account unsuspended.");
} finally {
  await connection.close();
}
