// Fixed VM setting. The path operand lets local tests use a fake daemon.json.
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync,
  rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const path = process.argv[2];
if (!path || process.argv.length !== 3) throw new Error("Expected daemon.json path");
const exists = existsSync(path);
const config = exists ? JSON.parse(readFileSync(path, "utf8")) : {};
if (!config || typeof config !== "object" || Array.isArray(config)) {
  throw new Error("Docker daemon config must be a JSON object");
}
if (Array.isArray(config.dns) && config.dns.length === 1 && config.dns[0] === "8.8.8.8") {
  console.log("unchanged");
} else {
  config.dns = ["8.8.8.8"];
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporary = mkdtempSync(join(directory, ".ma-dns-"));
  try {
    const file = join(temporary, "daemon.json");
    const mode = exists ? statSync(path).mode & 0o777 : 0o644;
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode });
    chmodSync(file, mode); // Preserve permissions even under a restrictive umask.
    renameSync(file, path);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  console.log("changed");
}
