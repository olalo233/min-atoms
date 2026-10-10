import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import type { Database } from "./client";
import { users } from "./schema";

type UserWriter = Pick<Database, "insert" | "update">;

// Parse the whole file before writing; never include passwords in errors/logs.
export async function seedDemoUsers(
  db: UserWriter,
  configuredFile = process.env.MA_DEMO_USERS_FILE ?? "~/.config/min-atoms/demo-users.txt",
): Promise<number> {
  const filename = configuredFile.startsWith("~/")
    ? resolve(homedir(), configuredFile.slice(2)) : resolve(configuredFile);
  const lines = (await readFile(filename, "utf8")).split(/\r?\n/)
    .map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  const accounts = lines.map((line) => {
    const separator = line.indexOf(":");
    const username = line.slice(0, separator).trim();
    const password = line.slice(separator + 1);
    if (separator < 1 || !username || !password) {
      throw new Error("Demo users file must contain username:password entries.");
    }
    return { username, password };
  });
  if (!accounts.length || new Set(accounts.map((account) => account.username)).size !== accounts.length) {
    throw new Error("Demo users file must contain unique usernames.");
  }
  for (const { username, password } of accounts) {
    const passwordHash = await bcrypt.hash(password, 12);
    await db.insert(users).values({ username, passwordHash }).onConflictDoUpdate({
      target: users.username, set: { passwordHash },
    });
  }
  return accounts.length;
}

export async function unsuspendUser(db: UserWriter, username: string): Promise<boolean> {
  const rows = await db.update(users).set({ suspendedAt: null, suspendedReason: null })
    .where(eq(users.username, username)).returning({ id: users.id });
  return rows.length > 0;
}
