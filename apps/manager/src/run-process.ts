import type { RpcTransport } from "./omp-rpc";

export const buildTools = "read,write,edit,bash,eval,grep,glob,todo";
export const chatTools = "read,grep,glob";
const processEnv = () => ({ PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" });
const execArgs = (container: string) => ["docker", "exec", "-i", "-u", "app", "-w", "/workspace", container];

export function spawnOmp(container: string, mode: "build" | "chat", restart: () => Promise<boolean>,
  spawn: typeof Bun.spawn = Bun.spawn): RpcTransport {
  const child = spawn([...execArgs(container), "omp", "--mode", "rpc", "--no-ui", "--tools",
    mode === "build" ? buildTools : chatTools], { env: processEnv(), stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  return { stdout: child.stdout, exited: child.exited,
    send(line) { child.stdin.write(line); child.stdin.flush(); },
    close() { child.stdin.end(); }, kill() { child.kill("SIGKILL"); },
    cleanup: restart,
  };
}
export type CommandResult = { exitCode: number; output: string };
export type RunCommand = (container: string, argv: string[], signal?: AbortSignal) => Promise<CommandResult>;
// Only checks receive the cancellation signal. Commit/stash commands are
// manager-owned stages; cancelling never kills a different container exec.
export const runCommand = async (container: string, argv: string[], signal?: AbortSignal, spawn: typeof Bun.spawn = Bun.spawn) => {
  if (signal?.aborted) throw new Error("Run cancelled");
  const child = spawn([...execArgs(container), ...argv], {
    env: processEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const abort = () => { child.kill("SIGKILL"); };
  signal?.addEventListener("abort", abort, { once: true });
  // Keep only the tail used by repair prompts; never retain unlimited output.
  const tail = async (stream: ReadableStream<Uint8Array>) => {
    let output = ""; const decoder = new TextDecoder();
    for await (const chunk of stream) output = (output + decoder.decode(chunk, { stream: true })).slice(-4000);
    return output + decoder.decode();
  };
  try {
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, tail(child.stdout), tail(child.stderr)]);
    if (signal?.aborted) throw new Error("Run cancelled");
    return { exitCode, output: (stdout + stderr).slice(-4000) };
  } finally { signal?.removeEventListener("abort", abort); }
};
