// Wire contract: omp v18.8.4 modes/rpc/rpc-types.ts and rpc-mode.ts.
export type Frame = Record<string, any>;
export const stopFailureContent = "停止时环境异常，应用可能没有完全停止，请稍后重试";
export interface RpcTransport {
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  send(line: string): void;
  close(): void;
  kill(): void;
  // Restart this project container and wait for preview readiness.
  cleanup(): Promise<boolean>;
}
export interface RpcTimers {
  after(callback: () => void, ms: number): () => void;
}
export const rpcTimers: RpcTimers = {
  after(callback, ms) { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); },
};
function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // A disconnect may precede the caller awaiting a ready/result promise.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

async function* frames(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (line.length > 64 * 1024 * 1024) throw new Error("OMP frame too large");
        if (line.trim()) yield JSON.parse(line) as Frame;
      }
      if (buffer.length > 64 * 1024 * 1024) throw new Error("OMP frame too large");
      if (done) break;
    }
    if (buffer.trim()) yield JSON.parse(buffer) as Frame;
  } finally { reader.releaseLock(); }
}

export class OmpRpc {
  private readonly ready = pending<void>();
  private readonly responses = new Map<string, { command: string; result: ReturnType<typeof pending<Frame>> }>();
  private promptWait?: { id: string; result: ReturnType<typeof pending<Frame>>; terminal?: Frame };
  private counter = 0;
  private failure?: Error;
  private closing = false;
  private settled = false;
  private closed?: Promise<void>;
  private aborting?: Promise<void>;
  private cancelling = false;
  private readonly drained: Promise<void>;

  constructor(private readonly transport: RpcTransport, private readonly onFrame: (frame: Frame) => void,
    private readonly timers: RpcTimers = rpcTimers) {
    this.drained = (async () => {
      try {
        for await (const frame of frames(transport.stdout)) this.receive(frame);
        if (!this.closing) this.fail(new Error("OMP output closed before completion"));
      } catch { this.fail(new Error("Invalid OMP stream")); }
    })();
    void transport.exited.catch(() => this.fail(new Error("OMP transport failed")));
  }

  private fail(error: Error) {
    this.failure ??= error;
    this.ready.reject(error);
    for (const { result } of this.responses.values()) result.reject(error);
    this.responses.clear();
    this.promptWait?.result.reject(error);
  }

  private receive(frame: Frame) {
    if (!frame || typeof frame.type !== "string") throw new Error("Invalid OMP frame");
    if (frame.type === "ready") {
      if (frame.protocolVersion !== 1) throw new Error("Unsupported OMP protocol");
      this.ready.resolve();
    }
    if (frame.type === "response") {
      const response = this.responses.get(frame.id);
      if (response && response.command === frame.command) {
        this.responses.delete(frame.id);
        if (frame.success === true) response.result.resolve(frame);
        else response.result.reject(new Error(`OMP ${frame.command} rejected`));
      }
      if (frame.id === this.promptWait?.id && frame.success === false) {
        this.promptWait?.result.reject(new Error("OMP prompt rejected"));
      }
    }
    const prompt = this.promptWait;
    if (prompt && frame.type === "prompt_result" && frame.id === prompt.id) {
      if (!["completed", "aborted", "error"].includes(frame.status) || typeof frame.sessionSettled !== "boolean") {
        throw new Error("Invalid OMP prompt result");
      }
      prompt.terminal = frame;
      if (frame.sessionSettled) { this.settled = true; prompt.result.resolve(frame); }
    } else if (prompt?.terminal && frame.type === "session_settled") {
      this.settled = true;
      prompt.result.resolve(prompt.terminal);
    }
    this.onFrame(frame);
  }

  private send(frame: Frame) {
    if (this.failure) throw this.failure;
    this.transport.send(`${JSON.stringify(frame)}\n`);
  }

  private async request(command: string, fields: Frame = {}): Promise<Frame> {
    const id = `manager-${++this.counter}`;
    const result = pending<Frame>();
    this.responses.set(id, { command, result });
    let stop = () => {};
    try {
      stop = this.timers.after(() => result.reject(new Error(`OMP ${command} timed out`)), 30_000);
      this.send({ ...fields, type: command, id });
      return await result.promise;
    } finally { stop(); this.responses.delete(id); }
  }

  async open(mode: "build" | "chat", signal: AbortSignal) {
    const stopped = pending<never>();
    const abort = () => stopped.reject(new Error("Run cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    const deadline = this.timers.after(() => stopped.reject(new Error("OMP ready timed out")), 30_000);
    try {
      if (signal.aborted) abort();
      await Promise.race([this.ready.promise, stopped.promise]);
      const response = await Promise.race([this.request("open_session", {
        sessionDir: "/state/omp-sessions", provider: "ma-gateway", modelId: "deepseek-flash",
      }), stopped.promise]);
      if (response.data?.cancelled !== false) throw new Error("OMP session open cancelled");
      if (signal.aborted) throw new Error("Run cancelled");
      if (mode === "chat") {
        const state = await Promise.race([this.request("get_state"), stopped.promise]);
        const names = state.data?.dumpTools?.map((tool: Frame) => tool.name);
        if (!Array.isArray(names) || names.length !== 3 || [...names].sort().join(",") !== "glob,grep,read") {
          throw new Error("讨论工具集不符合只读约定");
        }
      }
    } finally { deadline(); signal.removeEventListener("abort", abort); }
  }

  async prompt(message: string): Promise<Frame> {
    const id = `manager-${++this.counter}`;
    const result = pending<Frame>();
    this.settled = false;
    this.promptWait = { id, result };
    try { this.send({ type: "prompt", id, message }); return await result.promise; }
    finally { this.promptWait = undefined; }
  }

  // The prompt result and settlement get at most 5s. A spawned build always
  // restarts; chat only restarts when the session could not settle in time.
  abort(restartAlways = false): Promise<void> {
    return this.aborting ??= (async () => {
      this.cancelling = true;
      const terminal = this.promptWait?.result.promise;
      const done = pending<void>();
      const stop = this.timers.after(() => done.resolve(), 5000);
      let settled = this.settled;
      try {
        try { this.send({ type: "abort", id: `manager-abort-${++this.counter}` }); } catch { /* Restart below if unsettled. */ }
        if (terminal) {
          void terminal.then(() => { settled = true; done.resolve(); }, () => done.resolve());
          await done.promise;
        } else if (!settled) {
          // An opening/idle session has no prompt result. Give EOF the same
          // bounded opportunity to complete before deciding chat needs restart.
          this.closing = true;
          try { this.transport.close(); } catch { /* Restart below. */ }
          void Promise.all([this.drained, this.transport.exited]).then(() => { settled = true; done.resolve(); }, () => done.resolve());
          await done.promise;
        }
      } finally { stop(); }
      try {
        if (restartAlways || !settled) {
          this.closing = true;
          try { this.transport.kill(); } catch { /* The container restart still must run. */ }
          if (!await this.transport.cleanup()) throw new Error(stopFailureContent);
        }
      } catch { throw new Error(stopFailureContent); }
      finally { this.fail(new Error("Run cancelled")); }
    })();
  }

  private async force() {
    try { this.transport.kill(); }
    finally {
      // Cancellation owns its single restart, including failed restarts.
      if (!this.cancelling && !await this.transport.cleanup()) throw new Error("OMP cleanup failed");
    }
  }

  close(): Promise<void> {
    return this.closed ??= this.closeTransport();
  }

  private async closeTransport() {
    this.closing = true;
    this.transport.close();
    const done = pending<boolean>();
    const stop = this.timers.after(() => done.resolve(false), 5000);
    void Promise.all([this.drained, this.transport.exited]).then(() => done.resolve(true), () => done.resolve(false));
    try { if (!await done.promise) await this.force(); }
    finally { stop(); }
  }
}
