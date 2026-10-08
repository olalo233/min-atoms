/** T05 recorder only; no production manager behavior.
 * Protocol/flags pinned to https://github.com/can1357/oh-my-pi/tree/v18.8.4/packages/coding-agent/src
 * See modes/rpc/rpc-types.ts, modes/rpc/rpc-mode.ts and cli/flag-tables.ts.
 * Stream payloads: https://github.com/can1357/oh-my-pi/blob/v18.8.4/packages/agent/src/types.ts
 * and https://github.com/can1357/oh-my-pi/blob/v18.8.4/packages/ai/src/types.ts.
 * Examples (fake labels; --tools is an operator-measured list, not a safety guarantee):
 * bun apps/manager/scripts/omp-spike.ts --container fake-container --out /tmp/snake.ndjson --prompt '做一个贪吃蛇小游戏：用方向键或 WASD 控制，吃到食物会变长并加分，撞墙或撞到自己就结束，可以暂停和重新开始，并记录最高分。'
 * bun apps/manager/scripts/omp-spike.ts --container fake-container --out /tmp/followup.ndjson --prompt '加一个最高分排行'
 * bun apps/manager/scripts/omp-spike.ts --container fake-container --out /tmp/chat.ndjson --no-tools --prompt '解释当前应用'
 * bun apps/manager/scripts/omp-spike.ts --container fake-container --out /tmp/abort.ndjson --abort-after-ms 1000 --prompt '构建贪吃蛇'
 * Repeat with the same container/session directory to measure cross-process resume.
 * --provider fake-provider --model fake-model selects a catalog entry via open_session.
 * --tools read,grep is only an example candidate; PM must verify the actual read-only allowlist.
 * Recording policy: message_update.message/assistantMessageEvent and
 * tool_execution_update.args/partialResult, tool_stream_update.update have all
 * content strings withheld, including deltas and cumulative partial snapshots.
 * Event/role/content discriminants, IDs outside these payloads, numbers, booleans,
 * and arrival timing remain available. Use redacted message_end/tool_execution_end
 * for complete content; interrupted streams may have no complete content event.
 */
import { openSync, closeSync, writeSync } from "node:fs";

type Frame = Record<string, unknown>;
export interface Transport {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  send(line: string): void;
  close(): void;
  kill(): void;
  cleanup(): Promise<boolean>;
}
export interface SpikeOptions {
  container: string;
  prompt: string;
  tools?: string;
  noTools?: boolean;
  provider?: string;
  model?: string;
  timeoutMs: number;
  abortAfterMs?: number;
  graceMs: number;
}

export function redact(text: string, container: string): string {
  return text.replace(/([?&]token=)[^&#\s"'<>\\]*/gi, "$1[REDACTED]")
    .replace(/\bma-[a-z0-9]{8}\.expii\.top\b/gi, "preview.invalid")
    .split(container).join("[CONTAINER]");
}

// Redact parsed values rather than raw JSON: escaping and frame structure survive.
export function redactFrame(value: unknown, container: string): unknown {
  if (typeof value === "string") return redact(value, container);
  if (Array.isArray(value)) return value.map(item => redactFrame(item, container));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [redact(key, container), redactFrame(item, container)]));
  }
  return value;
}

// Never persist a fragment first: a later delta can complete a hostname/token.
// Fixed safe discriminants retain content shape; all other payload strings are
// deliberately unavailable, even benign text and provider/model metadata.
function withholdIncremental(value: unknown): unknown {
  if (typeof value === "string") return "[WITHHELD_INCREMENTAL_CONTENT]";
  if (Array.isArray(value)) return value.map(withholdIncremental);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      typeof item === "string" && ((key === "type" && ["text", "thinking", "toolCall", "image"].includes(item)) ||
      (key === "role" && ["assistant", "user", "toolResult"].includes(item)))
        ? item : withholdIncremental(item)]));
  }
  return value;
}

function recordingFrame(event: Frame, container: string): Frame {
  const safe = redactFrame(event, container) as Frame;
  const fields = event.type === "message_update" ? ["message", "assistantMessageEvent"]
    : event.type === "tool_execution_update" ? ["args", "partialResult"]
    : event.type === "tool_stream_update" ? ["update"] : [];
  for (const field of fields) {
    if (!(field in safe)) continue;
    const original = safe[field];
    safe[field] = withholdIncremental(original);
    // Preserve the actual text/thinking/toolcall event name, including start/end.
    if (field === "assistantMessageEvent" && original && typeof original === "object" && !Array.isArray(original))
      (safe[field] as Frame).type = (original as Frame).type;
  }
  return safe;
}

export async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end).replace(/\r$/, "");
        if (line.length > 4 * 1024 * 1024) throw new Error("frame too large");
        pending = pending.slice(end + 1);
        if (line.trim()) yield line;
      }
      if (pending.length > 4 * 1024 * 1024) throw new Error("frame too large");
      if (done) break;
    }
    if (pending.trim()) yield pending;
  } finally {
    reader.releaseLock();
  }
}

export async function runSpike(
  transport: Transport,
  options: SpikeOptions,
  record: (line: string) => void,
  trace: (entry: Frame) => void,
  signal?: AbortSignal,
) {
  const start = performance.now();
  const elapsed = () => Math.round(performance.now() - start);
  const timers: ReturnType<typeof setTimeout>[] = [];
  let outcome = "";
  let promptSent = false;
  let promptResult: Frame | undefined;
  let promptResultMs: number | undefined;
  let settledMs: number | undefined;
  let abortMs: number | undefined;
  let abortReason: string | undefined;
  let promptSentMs: number | undefined;
  let childExit: number | undefined;
  let forcedCleanup = false;
  let cleanupOk = true;
  let resolveDone!: () => void;
  const done = new Promise<void>(resolve => { resolveDone = resolve; });
  const log = (entry: Frame) => trace(redactFrame({ elapsedMs: elapsed(), ...entry }, options.container) as Frame);
  const finish = (reason: string) => {
    if (!outcome) { outcome = reason; resolveDone(); }
  };
  const timer = (fn: () => void, ms: number) => timers.push(setTimeout(fn, ms));
  const send = (frame: Frame) => {
    transport.send(`${JSON.stringify(frame)}\n`);
    log({ kind: "sent", type: frame.type, id: frame.id });
  };
  const complete = () => {
    if (promptResult && settledMs !== undefined) finish(String(promptResult.status));
  };
  const abort = (reason = "operator") => {
    if (outcome || abortMs !== undefined) return;
    if (!promptSent) { finish("interrupted"); return; }
    abortMs = elapsed();
    abortReason = reason;
    try { send({ id: "spike-abort", type: "abort" }); }
    catch { finish("transport_error"); return; }
    timer(() => finish("abort_timeout"), options.graceMs);
  };
  const stdoutTask = (async () => {
    try {
      for await (const line of lines(transport.stdout)) {
        const frame: unknown = JSON.parse(line);
        if (!frame || typeof frame !== "object" || Array.isArray(frame) ||
          typeof (frame as Frame).type !== "string") throw new Error("invalid frame");
        const event = frame as Frame;
        record(`${JSON.stringify(recordingFrame(event, options.container))}\n`);
        log({ kind: "received", type: event.type, id: event.id, status: event.status,
          sessionSettled: event.sessionSettled });
        if (outcome) continue;
        if (!promptSent && event.type === "response" && event.id === "spike-open" && event.command === "open_session") {
          const data = event.data as Frame | undefined;
          if (event.success !== true || data?.cancelled !== false) { finish("open_failed"); continue; }
          promptSent = true;
          promptSentMs = elapsed();
          send({ id: "spike-prompt", type: "prompt", message: options.prompt });
          timer(() => abort("deadline"), options.timeoutMs);
          if (options.abortAfterMs !== undefined) timer(() => abort("scheduled"), options.abortAfterMs);
        } else if (event.type === "response" && event.id === "spike-prompt" && event.success === false) {
          finish("prompt_rejected");
        } else if (promptSent && event.type === "prompt_result" && event.id === "spike-prompt") {
          if (!["completed", "aborted", "error"].includes(String(event.status)) ||
            typeof event.sessionSettled !== "boolean") throw new Error("invalid result");
          promptResult = event;
          promptResultMs = elapsed();
          if (event.sessionSettled === true) settledMs = elapsed();
          complete();
        } else if (promptResult && event.type === "session_settled") {
          // This frame is uncorrelated. A pre-result frame remains recorded but
          // cannot override a later result explicitly reporting not settled.
          settledMs = elapsed();
          complete();
        }
      }
      finish("stdout_closed");
    } catch { finish("protocol_or_recording_error"); }
  })();
  const stderrTask = (async () => {
    try {
      for await (const line of lines(transport.stderr)) log({ kind: "stderr", text: line });
    } catch { finish("stderr_error"); }
  })();
  const exitTask = transport.exited.then(code => {
    childExit = code;
    // Drain buffered stdout before deciding that the child exited too early.
    return stdoutTask.then(() => finish("child_exit"));
  }).catch(() => finish("transport_error"));
  const onAbort = () => abort("signal");
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal?.aborted) abort("signal");
    else {
      log({ kind: "recording_policy", incrementalContent: "withheld; see recorder source for fields" });
      send({ id: "spike-open", type: "open_session", sessionDir: "/state/omp-sessions",
        ...(options.provider ? { provider: options.provider, modelId: options.model } : {}) });
      timer(() => { if (!promptSent) finish("open_timeout"); }, options.timeoutMs);
    }
    await done;
  } catch { finish("transport_error"); }
  finally {
    timers.forEach(clearTimeout);
    signal?.removeEventListener("abort", onAbort);
    try { transport.close(); } catch { /* Already disconnected. */ }
    const drained = Promise.all([stdoutTask, stderrTask, exitTask]).then(() => true);
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const graceful = await Promise.race([drained, new Promise<false>(resolve => {
      cleanupTimer = setTimeout(() => resolve(false), options.graceMs);
    })]);
    clearTimeout(cleanupTimer);
    if (!graceful) {
      forcedCleanup = true;
      // Killing a docker CLI alone does not reliably terminate its remote exec.
      try { cleanupOk = await transport.cleanup(); } catch { cleanupOk = false; }
      try { transport.kill(); } catch { cleanupOk = false; }
      await Promise.race([drained, Bun.sleep(options.graceMs)]);
    }
  }
  const result = { outcome, promptResult: !!promptResult, status: promptResult?.status,
    settled: settledMs !== undefined, promptSentMs, promptResultMs, settledMs, abortMs, abortReason,
    abortToResultMs: abortMs !== undefined && promptResultMs !== undefined ? promptResultMs - abortMs : undefined,
    childExit, forcedCleanup, cleanupOk, elapsedMs: elapsed() };
  log({ kind: "summary", ...result });
  return result;
}

export function dockerArgs(options: SpikeOptions, marker: string): string[] {
  return ["docker", "exec", "-i", "-u", "app", "-w", "/workspace", "-e", `OMP_SPIKE_CHILD=${marker}`,
    options.container, "omp", "--mode", "rpc", "--no-ui",
    ...(options.noTools ? ["--no-tools"] : options.tools ? ["--tools", options.tools] : [])];
}

// Only this invocation's unique environment marker is matched, never a process name.
export const cleanupScript = `
failed=0
for envfile in /proc/[0-9]*/environ; do
  if tr '\\000' '\\n' < "$envfile" 2>/dev/null | grep -Fxq "OMP_SPIKE_CHILD=$1"; then
    pid=$(basename "$(dirname "$envfile")")
    kill -KILL "$pid" 2>/dev/null || { [ ! -e "/proc/$pid" ] || failed=1; }
  fi
done
exit "$failed"
`;

function dockerTransport(options: SpikeOptions): Transport {
  const marker = crypto.randomUUID();
  const child = Bun.spawn(dockerArgs(options, marker), { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  return {
    stdout: child.stdout, stderr: child.stderr, exited: child.exited,
    send: line => { child.stdin.write(line); child.stdin.flush(); },
    close: () => { child.stdin.end(); },
    kill: () => { child.kill("SIGKILL"); },
    cleanup: async () => {
      const cleaner = Bun.spawn(["docker", "exec", "-u", "app", options.container,
        "sh", "-c", cleanupScript, "spike-cleanup", marker], { stdout: "ignore", stderr: "ignore" });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const code = await Promise.race([cleaner.exited, new Promise<number>(resolve => {
          timer = setTimeout(() => { cleaner.kill("SIGKILL"); resolve(-1); }, options.graceMs);
        })]);
        return code === 0;
      } finally { clearTimeout(timer); }
    },
  };
}

export function parseOptions(args: string[]): SpikeOptions & { out: string } {
  const values: Record<string, string> = {};
  const flags = new Set(["container", "out", "prompt", "tools", "provider", "model", "timeout-ms", "abort-after-ms"]);
  let noTools = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--no-tools") { noTools = true; continue; }
    const key = args[i].replace(/^--/, "");
    if (!args[i].startsWith("--") || !flags.has(key) || values[key] !== undefined || args[i + 1] === undefined)
      throw new Error("invalid options");
    values[key] = args[++i];
  }
  if (!values.container || values.container.startsWith("-") || !values.out || !values.prompt?.trim() ||
    (noTools && values.tools !== undefined) || values.tools === "" || !!values.provider !== !!values.model)
    throw new Error("missing or conflicting options");
  const positive = (value: string) => {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n <= 0 || n > 2_147_483_647) throw new Error("invalid timeout");
    return n;
  };
  return { container: values.container, out: values.out, prompt: values.prompt, tools: values.tools,
    noTools, provider: values.provider, model: values.model,
    timeoutMs: positive(values["timeout-ms"] ?? "600000"), graceMs: 5000,
    abortAfterMs: values["abort-after-ms"] === undefined ? undefined : positive(values["abort-after-ms"]) };
}

if (import.meta.main) {
  let fd: number | undefined;
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  try {
    const options = parseOptions(Bun.argv.slice(2));
    // Exclusive create avoids destroying an earlier real observation.
    fd = openSync(options.out, "wx", 0o600);
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);
    const result = await runSpike(dockerTransport(options), options,
      line => { writeSync(fd!, line); }, entry => { console.error(JSON.stringify(entry)); }, controller.signal);
    console.log(JSON.stringify(result));
    process.exitCode = ["completed", "aborted"].includes(result.outcome) && result.cleanupOk && result.childExit === 0 ? 0 : 1;
  } catch {
    // Never echo argv, spawn errors or output paths (they may contain private labels).
    console.error(JSON.stringify({ error: "spike failed; check options, output availability and docker executable" }));
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    if (fd !== undefined) closeSync(fd);
  }
}
