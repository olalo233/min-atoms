import { execFileSync } from "node:child_process";

import { getE2eEnvironment } from "./environment";

const repositoryRoot = process.cwd();
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function runNpm(script: "db:migrate" | "db:seed", environment: Record<string, string>) {
  const result = execFileSync(npmCommand, ["run", script], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, ...environment },
    stdio: "pipe",
  });

  return result;
}

export default function globalSetup() {
  const environment = getE2eEnvironment();

  try {
    runNpm("db:migrate", environment);
    runNpm("db:seed", environment);
  } catch {
    throw new Error(
      "Playwright could not prepare local PostgreSQL. Start `docker compose up -d postgres`, wait for it to be healthy, then rerun `npm run test:e2e`.",
    );
  }
}
