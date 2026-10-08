import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupScript, dockerArgs, lines, parseOptions, redactFrame, runSpike,
  type SpikeOptions, type Transport } from "../scripts/omp-spike";

const options: SpikeOptions = { container: "fake-container", prompt: "你好\nworld", timeoutMs: 100, graceMs: 10 };
const encoder = new TextEncoder();

function fake(onSend: (frame: Record<string, unknown>, emit: (frame: unknown) => void) => void, stubborn = false) {
  let output!: ReadableStreamDefaultController<Uint8Array>;
  let errors!: ReadableStreamDefaultController<Uint8Array>;
  let exit!: (code: number) => void;
  let stopped = false;
  const sent: string[] = [];
  const emit = (frame: unknown) => output.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
  const stop = (code: number) => {
    if (stopped) return;
    stopped = true; output.close(); errors.close(); exit(code);
  };
  let killed = false;
  let cleaned = false;
  const transport: Transport = {
    stdout: new ReadableStream({ start(controller) { output = controller; } }),
    stderr: new ReadableStream({ start(controller) { errors = controller; } }),
    exited: new Promise(resolve => { exit = resolve; }),
    send(line) {
      sent.push(line);
      const frame = JSON.parse(line);
      if (frame.type === "open_session") emit({ id: frame.id, type: "response", command: "open_session",
        success: true, data: { cancelled: false, resumed: true, sessionId: "fake-session" } });
      else onSend(frame, emit);
    },
    close() { if (!stubborn) stop(0); },
    kill() { killed = true; stop(137); },
    async cleanup() { cleaned = true; return true; },
  };
  return { transport, sent, emit, stderr: (line: string) => errors.enqueue(encoder.encode(line)),
    stop, wasKilled: () => killed, wasCleaned: () => cleaned };
}

test("UTF-8 JSONL framing survives split multibyte characters, CRLF and final unterminated line", async () => {
  const data = encoder.encode('{"type":"中文"}\r\n\n{"type":"end"}');
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    for (const byte of data) controller.enqueue(new Uint8Array([byte]));
    controller.close();
  } });
  const result = [];
  for await (const line of lines(stream)) result.push(JSON.parse(line));
  expect(result).toEqual([{ type: "中文" }, { type: "end" }]);
});

test("open acknowledgement gates prompt, command fields and newline framing match v18.8.4", async () => {
  const f = fake((frame, emit) => emit({ type: "prompt_result", id: frame.id, status: "completed", sessionSettled: true }));
  const records: string[] = [];
  const result = await runSpike(f.transport, { ...options, provider: "fake-provider", model: "fake-model" },
    line => records.push(line), () => {});
  expect(f.sent.every(line => line.endsWith("\n") && line.split("\n").length === 2)).toBe(true);
  expect(f.sent.map(line => JSON.parse(line))).toEqual([
    { id: "spike-open", type: "open_session", sessionDir: "/state/omp-sessions", provider: "fake-provider", modelId: "fake-model" },
    { id: "spike-prompt", type: "prompt", message: "你好\nworld" },
  ]);
  expect(result.outcome).toBe("completed");
  expect(result.settled).toBe(true);
  expect(records.map(line => JSON.parse(line).type)).toEqual(["response", "prompt_result"]);
  expect(f.wasKilled()).toBe(false);
});

test("prompt_result with false does not close child before session_settled; unrelated result is ignored", async () => {
  const f = fake((_, emit) => {
    emit({ type: "session_settled" });
    emit({ type: "prompt_result", id: "other", status: "completed", sessionSettled: true });
    emit({ type: "prompt_result", id: "spike-prompt", status: "completed", sessionSettled: false });
  });
  const trace: Record<string, unknown>[] = [];
  const running = runSpike(f.transport, options, () => {}, entry => trace.push(entry));
  await Bun.sleep(5);
  expect(trace.some(entry => entry.kind === "summary")).toBe(false);
  f.emit({ type: "tool_execution_end", toolName: "fake-tool" });
  f.emit({ type: "session_settled" });
  const result = await running;
  expect(result.outcome).toBe("completed");
  expect(result.settledMs!).toBeGreaterThanOrEqual(result.promptResultMs!);
  expect(trace.filter(entry => entry.kind === "received").map(entry => entry.type))
    .toContain("tool_execution_end");
});

test("abort records response separately from terminal prompt and waits for settled", async () => {
  const f = fake((frame, emit) => {
    if (frame.type !== "abort") return;
    emit({ type: "response", id: frame.id, command: "abort", success: true });
    emit({ type: "prompt_result", id: "spike-prompt", status: "aborted", sessionSettled: false });
    emit({ type: "session_settled" });
  });
  const recorded: string[] = [];
  const result = await runSpike(f.transport, { ...options, abortAfterMs: 1 }, line => recorded.push(line), () => {});
  expect(f.sent.map(line => JSON.parse(line).type)).toEqual(["open_session", "prompt", "abort"]);
  expect(result.outcome).toBe("aborted");
  expect(result.promptResult).toBe(true);
  expect(result.settled).toBe(true);
  expect(result.abortToResultMs!).toBeGreaterThanOrEqual(0);
  expect(recorded.map(line => JSON.parse(line).type)).toEqual(["response", "response", "prompt_result", "session_settled"]);
});

test("unresponsive abort is bounded and cleans only the spawned transport", async () => {
  const f = fake(() => {}, true);
  const result = await runSpike(f.transport, { ...options, abortAfterMs: 1 }, () => {}, () => {});
  expect(result.outcome).toBe("abort_timeout");
  expect(result.promptResult).toBe(false);
  expect(result.forcedCleanup).toBe(true);
  expect(f.wasCleaned()).toBe(true);
  expect(f.wasKilled()).toBe(true);
  expect(result.elapsedMs).toBeLessThan(500);
});

test("missing settled evidence reaches the deadline without claiming completion", async () => {
  const f = fake((frame, emit) => {
    if (frame.type === "prompt") emit({ type: "prompt_result", id: frame.id, status: "completed", sessionSettled: false });
  });
  const result = await runSpike(f.transport, { ...options, timeoutMs: 10 }, () => {}, () => {});
  expect(result.outcome).toBe("abort_timeout");
  expect(result.abortReason).toBe("deadline");
  expect(result.promptResult).toBe(true);
  expect(result.settled).toBe(false);
});

test("open_session cancellation stops before sending any prompt", async () => {
  const f = fake(() => {});
  f.transport.send = line => {
    f.sent.push(line);
    f.emit({ type: "response", id: "spike-open", command: "open_session", success: true, data: { cancelled: true } });
  };
  const result = await runSpike(f.transport, options, () => {}, () => {});
  expect(result.outcome).toBe("open_failed");
  expect(f.sent.map(line => JSON.parse(line).type)).toEqual(["open_session"]);
});

test("failed remote cleanup is explicit even if local child was killed", async () => {
  const f = fake(() => {}, true);
  f.transport.cleanup = async () => false;
  const result = await runSpike(f.transport, { ...options, abortAfterMs: 1 }, () => {}, () => {});
  expect(result.cleanupOk).toBe(false);
  expect(result.childExit).toBe(137);
});

test("signal cancellation sends abort on the same transport", async () => {
  const controller = new AbortController();
  const f = fake((frame, emit) => {
    if (frame.type === "prompt") controller.abort();
    if (frame.type === "abort") emit({ type: "prompt_result", id: "spike-prompt", status: "aborted", sessionSettled: true });
  });
  const result = await runSpike(f.transport, options, () => {}, () => {}, controller.signal);
  expect(result.outcome).toBe("aborted");
  expect(f.sent.map(line => JSON.parse(line).type)).toContain("abort");
});

test("nested event payload and stderr redaction preserves JSON, escapes, tool data and numeric fields", async () => {
  const unsafe = 'https://ma-ab12cd34.expii.top/src?token=secret-123&x=1 fake-container "quoted"\n';
  const event = { type: "message_update", count: 3, nested: [unsafe, { ok: true }] };
  const f = fake((frame, emit) => {
    emit(event);
    emit({ type: "prompt_result", id: frame.id, status: "completed", sessionSettled: true });
  });
  f.stderr(`${unsafe.replace(/\n/g, " ")}\n`);
  const records: string[] = [];
  const traces: Record<string, unknown>[] = [];
  await runSpike(f.transport, options, line => records.push(line), entry => traces.push(entry));
  const all = records.join("") + JSON.stringify(traces);
  expect(all).not.toContain("secret-123");
  expect(all).not.toContain("ma-ab12cd34.expii.top");
  expect(all).not.toContain("fake-container");
  expect(JSON.parse(records[1])).toEqual(redactFrame(event, options.container));
  expect(JSON.parse(records[1]).nested[0]).toContain('?token=[REDACTED]&x=1');
});

for (const type of ["text_delta", "thinking_delta", "toolcall_delta"]) {
  test(`${type} recording withholds split secrets and both cumulative snapshots, preserving final message`, async () => {
    const fragments = ["https://ma-ab12", "cd34.expii.top?token=", "FAKE_SECRET&ok=1"];
    const message = (text: string) => ({ role: "assistant", content: [
      { type: "text", text }, { type: "thinking", thinking: text },
      { type: "toolCall", id: "fake-call", name: "fake-tool", arguments: { url: text } },
    ], usage: { totalTokens: 7 } });
    const f = fake((frame, emit) => {
      let cumulative = "";
      for (const delta of fragments) {
        cumulative += delta;
        emit({ type: "message_update", messageId: "fake-message", message: message(cumulative),
          assistantMessageEvent: { type, contentIndex: 0, delta, partial: message(cumulative) } });
      }
      emit({ type: "message_update", messageId: "fake-message", message: message(cumulative),
        assistantMessageEvent: { type: type.replace("_delta", "_end"), contentIndex: 0,
          content: cumulative, partial: message(cumulative) } });
      emit({ type: "message_end", messageId: "fake-message", message: message(cumulative) });
      emit({ type: "prompt_result", id: frame.id, status: "completed", sessionSettled: false });
      emit({ type: "session_settled" });
    });
    const records: string[] = [];
    const traces: Record<string, unknown>[] = [];
    const result = await runSpike(f.transport, options, line => {
      // Inspect each write immediately, before any later frame can arrive.
      expect(line).not.toContain("FAKE_SECRET");
      expect(line).not.toContain("ma-ab12");
      records.push(line);
    }, entry => traces.push(entry));
    expect(result.outcome).toBe("completed");
    expect(result.promptResult && result.settled).toBe(true);
    const frames = records.map(line => JSON.parse(line));
    const updates = frames.filter(frame => frame.type === "message_update");
    const deltas = updates.slice(0, 3).map(frame => frame.assistantMessageEvent.delta).join("");
    expect(deltas).toBe("[WITHHELD_INCREMENTAL_CONTENT]".repeat(3));
    expect(updates.map(frame => frame.assistantMessageEvent.type))
      .toEqual([type, type, type, type.replace("_delta", "_end")]);
    for (const update of updates) {
      expect(update.messageId).toBe("fake-message");
      expect(update.assistantMessageEvent.contentIndex).toBe(0);
      for (const snapshot of [update.message, update.assistantMessageEvent.partial]) {
        expect(snapshot.role).toBe("assistant");
        expect(snapshot.usage.totalTokens).toBe(7);
        expect(snapshot.content.map((part: { type: string }) => part.type)).toEqual(["text", "thinking", "toolCall"]);
        expect(snapshot.content[0].text).toBe("[WITHHELD_INCREMENTAL_CONTENT]");
        expect(snapshot.content[1].thinking).toBe("[WITHHELD_INCREMENTAL_CONTENT]");
        expect(snapshot.content[2].arguments.url).toBe("[WITHHELD_INCREMENTAL_CONTENT]");
      }
    }
    const final = frames.find(frame => frame.type === "message_end");
    expect(final).toEqual(redactFrame({ type: "message_end", messageId: "fake-message",
      message: message(fragments.join("")) }, options.container));
    expect(final.message.content[0].text).toBe("https://preview.invalid?token=[REDACTED]&ok=1");
    const saved = records.join("") + JSON.stringify(traces);
    expect(saved).not.toContain("FAKE_SECRET");
    expect(saved).not.toContain("ma-ab12cd34.expii.top");
    expect(traces.some(entry => entry.kind === "recording_policy")).toBe(true);
    expect(traces.filter(entry => entry.kind === "received").map(entry => entry.type))
      .toEqual(frames.map(frame => frame.type));
  });
}

for (const type of ["tool_execution_update", "tool_stream_update"]) {
  test(`${type} recording withholds incremental tool output even when abort leaves no final content`, async () => {
    const f = fake((frame, emit) => {
      if (frame.type === "prompt") {
        let cumulative = "";
        for (const text of ["https://ma-ab12", "cd34.expii.top?token=", "FAKE_SECRET&ok=1"]) {
          cumulative += text;
          const payload = { content: [{ type: "text", text }], details: { cumulative, done: false, count: 3 } };
          emit({ type, toolCallId: "fake-call", toolName: "fake-tool",
            ...(type === "tool_execution_update" ? { args: { url: cumulative }, partialResult: payload } : { update: payload }) });
        }
      } else if (frame.type === "abort") {
        emit({ type: "prompt_result", id: "spike-prompt", status: "aborted", sessionSettled: false });
        emit({ type: "session_settled" });
      }
    });
    const records: string[] = [];
    const traces: Record<string, unknown>[] = [];
    const result = await runSpike(f.transport, { ...options, abortAfterMs: 1 },
      line => records.push(line), entry => traces.push(entry));
    expect(result.outcome).toBe("aborted");
    expect(result.promptResult && result.settled).toBe(true);
    const frames = records.map(line => JSON.parse(line));
    const updates = frames.filter(frame => frame.type === type);
    expect(updates).toHaveLength(3);
    const reconstructed = updates.map(frame => (frame.partialResult ?? frame.update).content[0].text).join("");
    expect(reconstructed).toBe("[WITHHELD_INCREMENTAL_CONTENT]".repeat(3));
    for (const update of updates) {
      expect(update.toolCallId).toBe("fake-call");
      expect(update.toolName).toBe("fake-tool");
      const payload = update.partialResult ?? update.update;
      expect(payload.details).toEqual({ cumulative: "[WITHHELD_INCREMENTAL_CONTENT]", done: false, count: 3 });
      if (update.args) expect(update.args.url).toBe("[WITHHELD_INCREMENTAL_CONTENT]");
    }
    const saved = records.join("") + JSON.stringify(traces);
    expect(saved).not.toContain("FAKE_SECRET");
    expect(saved).not.toContain("ma-ab12");
    expect(saved).not.toContain("cd34.expii.top");
    expect(frames.some(frame => ["message_end", "tool_execution_end"].includes(frame.type))).toBe(false);
    expect(result.abortToResultMs!).toBeGreaterThanOrEqual(0);
  });
}

test("protocol failure and recording failure terminate without echoing invalid payload", async () => {
  const f = fake((_, emit) => emit({ type: "prompt_result", id: "spike-prompt", status: "invented", sessionSettled: true }));
  const result = await runSpike(f.transport, options, () => {}, () => {});
  expect(result.outcome).toBe("protocol_or_recording_error");
  const failedWriter = fake(() => {});
  expect((await runSpike(failedWriter.transport, options, () => { throw new Error("private label"); }, () => {})).outcome)
    .toBe("protocol_or_recording_error");
});

test("tool flags and cleanup marker are scoped, model pair and timeout inputs validated", () => {
  expect(dockerArgs({ ...options, tools: "read,grep" }, "fake-marker")).toEqual([
    "docker", "exec", "-i", "-u", "app", "-w", "/workspace", "-e", "OMP_SPIKE_CHILD=fake-marker",
    "fake-container", "omp", "--mode", "rpc", "--no-ui", "--tools", "read,grep",
  ]);
  expect(dockerArgs({ ...options, noTools: true }, "fake-marker").slice(-1)).toEqual(["--no-tools"]);
  expect(cleanupScript).toContain('grep -Fxq "OMP_SPIKE_CHILD=$1"');
  expect(cleanupScript).not.toContain("pkill");
  const base = ["--container", "fake-container", "--out", "/tmp/fake.ndjson", "--prompt", "hello"];
  expect(parseOptions(base).timeoutMs).toBe(600000);
  expect(() => parseOptions([...base, "--provider", "fake-provider"])).toThrow();
  expect(() => parseOptions([...base, "--timeout-ms", "NaN"])).toThrow();
  expect(() => parseOptions([...base, "--tools", "read", "--no-tools"])).toThrow();
  expect(() => parseOptions([...base, "--api-key", "secret"])).toThrow();
});

test("CLI with a fake docker subprocess records raw frames and sanitized diagnostics, never argv", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-spike-test-"));
  try {
    const fakeDocker = `#!${process.execPath}
const args = Bun.argv.slice(2);
if (args.join('|') !== 'exec|-i|-u|app|-w|/workspace|-e|' + args[7] + '|fake-container|omp|--mode|rpc|--no-ui') process.exit(2);
if (!args[7].startsWith('OMP_SPIKE_CHILD=')) process.exit(3);
for await (const line of console) {
  if (!line.trim()) continue;
  const frame = JSON.parse(line);
  if (frame.type === 'open_session') {
    console.log(JSON.stringify({ type: 'response', id: frame.id, command: 'open_session', success: true,
      data: { cancelled: false, resumed: true, sessionId: 'fake-session' } }));
  } else if (frame.type === 'prompt') {
    console.error('fake-container https://ma-ab12cd34.expii.top?token=fake-secret&ok=1');
    console.log(JSON.stringify({ type: 'prompt_result', id: frame.id, status: 'completed', sessionSettled: false }));
    await Bun.sleep(5);
    console.log(JSON.stringify({ type: 'session_settled' }));
  }
}
`;
    writeFileSync(join(dir, "docker"), fakeDocker, { mode: 0o700 });
    const out = join(dir, "fake-recording.ndjson");
    const child = Bun.spawn([process.execPath, "apps/manager/scripts/omp-spike.ts", "--container", "fake-container",
      "--out", out, "--prompt", "fake prompt", "--timeout-ms", "1000"], {
      env: { PATH: dir }, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stdout, stderr }).toMatchObject({ code: 0 });
    expect(JSON.parse(stdout).outcome).toBe("completed");
    expect(JSON.parse(stdout).settled).toBe(true);
    expect(stderr).not.toContain("fake-container");
    expect(stderr).not.toContain("fake-secret");
    expect(stderr).not.toContain("ma-ab12cd34.expii.top");
    expect(readFileSync(out, "utf8").trim().split("\n").map(line => JSON.parse(line).type))
      .toEqual(["response", "prompt_result", "session_settled"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
