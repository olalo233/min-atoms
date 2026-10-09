import { expect, test } from "bun:test";
import { runCommand, spawnOmp, buildTools, chatTools } from "../src/run-process";
import { deferred } from "./helpers";

function hostExec() {
  const exit = deferred<number>();
  const commands: string[][] = [];
  const environments: Record<string, string>[] = [];
  const kills: string[] = [];
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  let ended = false;
  const stream = () => new ReadableStream<Uint8Array>({ start(controller) { streams.push(controller); } });
  const end = () => {
    if (ended) return;
    ended = true;
    for (const controller of streams) controller.close();
    exit.resolve(0);
  };
  const child = { stdout: stream(), stderr: stream(), exited: exit.promise,
    stdin: { write() {}, flush() {}, end }, kill(signal: string) { kills.push(signal); end(); } };
  const spawn = ((argv: string[], options: { env: Record<string, string> }) => {
    commands.push(argv); environments.push(options.env); return child;
  }) as unknown as typeof Bun.spawn;
  return { spawn, commands, environments, kills, end };
}

test("check cancellation kills only its host docker-exec client with PATH-only environment", async () => {
  const host = hostExec(); const controller = new AbortController();
  const check = runCommand("ma-00000001", ["bun", "run", "check"], controller.signal, host.spawn);
  controller.abort();
  await expect(check).rejects.toThrow("Run cancelled");
  expect(host.kills).toEqual(["SIGKILL"]);
  expect(host.commands).toEqual([["docker", "exec", "-i", "-u", "app", "-w", "/workspace", "ma-00000001", "bun", "run", "check"]]);
  expect(host.environments).toEqual([{ PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" }]);
  await expect(runCommand("ma-00000001", ["bun", "run", "check"], controller.signal, host.spawn)).rejects.toThrow("Run cancelled");
  expect(host.commands).toHaveLength(1);
});

test("omp transport keeps tool configuration and delegates cleanup to project restart/readiness", async () => {
  for (const mode of ["build", "chat"] as const) {
    const host = hostExec(); const ready = deferred<boolean>(); let restarts = 0;
    const rpc = spawnOmp("ma-00000001", mode, () => { restarts++; return ready.promise; }, host.spawn);
    expect(host.commands).toEqual([["docker", "exec", "-i", "-u", "app", "-w", "/workspace", "ma-00000001",
      "omp", "--mode", "rpc", "--no-ui", "--tools", mode === "build" ? buildTools : chatTools]]);
    expect(Object.keys(host.environments[0])).toEqual(["PATH"]);
    const cleanup = rpc.cleanup(); let finished = false;
    void cleanup.then(() => { finished = true; });
    await Promise.resolve(); expect(finished).toBe(false);
    ready.resolve(mode === "build"); expect(await cleanup).toBe(mode === "build");
    expect(restarts).toBe(1); expect(host.commands).toHaveLength(1);
    rpc.kill(); await rpc.exited;
  }
});
