// Starts both dev processes and forwards signals:
//   1. Vite dev server on :5173 (serves the frontend, proxies /api)
//   2. Hono API server on :3001 (restarts on file changes)
// Do not change the ports; the preview environment depends on them.

const procs = [
  Bun.spawn(["vite"], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  }),
  Bun.spawn(["bun", "--watch", "src/server/index.ts"], {
    stdout: "inherit",
    stderr: "inherit",
  }),
];

function shutdown(code = 0): never {
  for (const proc of procs) proc.kill();
  process.exit(code);
}

process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());

// If either process exits, stop the other and exit with the same code.
const exitCode = await Promise.race(procs.map((proc) => proc.exited));
shutdown(exitCode);

export {};
