import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createDatabase } from "./client";
import { previewHosts } from "./schema";

import { seedDemoUsers } from "./demo-users";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required to seed the database.");

const configuredFile = process.env.PREVIEW_HOSTS_FILE ?? "~/.config/min-atoms/preview-hosts.txt";
const hostsFile = configuredFile.startsWith("~/")
  ? resolve(homedir(), configuredFile.slice(2)) : resolve(configuredFile);
const contents = await readFile(hostsFile, "utf8");
const labels = [...new Set(contents.split(/\r?\n/).map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"))
  .map((host) => host.replace(/\.expii\.top$/, "")))];
if (!labels.length || labels.some((label) => !/^ma-[a-z0-9]{8}$/.test(label))) {
  throw new Error("Preview host file must contain ma-<8 lowercase letters or digits> labels or expii.top hostnames.");
}

const connection = createDatabase(databaseUrl);
try {
  await connection.db.transaction(async (tx) => {
    await seedDemoUsers(tx);
    await tx.insert(previewHosts).values(labels.map((label) => ({ label }))).onConflictDoNothing();
  });
  console.log(`Seeded demo users and ${labels.length} preview host entries.`);
} finally {
  await connection.close();
}
