import "dotenv/config";

import { users } from "@/db/schema";
import { closeDatabase, getDb } from "@/lib/db/client";
import { hashPassword } from "@/lib/auth/password";

async function main() {
  const username = process.env.DEMO_USERNAME;
  const password = process.env.DEMO_PASSWORD;

  if (!username || !password) {
    throw new Error(
      "DEMO_USERNAME and DEMO_PASSWORD are required to seed the Demo User.",
    );
  }

  const passwordHash = await hashPassword(password);

  await getDb()
    .insert(users)
    .values({ username, passwordHash })
    .onConflictDoUpdate({
      target: users.username,
      set: { passwordHash },
    });

  console.log(`Seeded Demo User: ${username}`);
  await closeDatabase();
}

main().catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : "Failed to seed Demo User.");
  await closeDatabase();
  process.exitCode = 1;
});
