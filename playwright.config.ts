import { defineConfig, devices } from "@playwright/test";

import { getE2eEnvironment } from "./tests/e2e/environment";

const environment = getE2eEnvironment();
const processEnvironment: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  ),
);

export default defineConfig({
  fullyParallel: false,
  globalSetup: "./tests/e2e/global-setup.ts",
  reporter: "list",
  testDir: "./tests/e2e",
  timeout: 45_000,
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: "npm run dev -- --hostname 127.0.0.1 --port 3000",
    env: { ...processEnvironment, ...environment },
    reuseExistingServer: false,
    timeout: 60_000,
    url: "http://127.0.0.1:3000/login",
  },
  workers: 1,
});
