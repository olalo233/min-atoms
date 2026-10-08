import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

// Keep the existing Vitest auth suite isolated from Bun's module mocks.
// Each workspace owns its test runner; this is the root acceptance entry point.
describe("workspace tests", () => {
  for (const workspace of ["apps/web", "apps/manager", "packages/db", "packages/protocol"]) {
    test(workspace, async () => {
      const result = Bun.spawn([process.execPath, "run", "test"], {
        cwd: resolve(import.meta.dir, "..", workspace),
        stdout: "inherit",
        stderr: "inherit",
      });
      expect(await result.exited).toBe(0);
    }, 60_000);
  }
});
