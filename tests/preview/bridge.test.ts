import { describe, expect, it, vi } from "vitest";

import {
  createPreviewBridge,
  type PreviewBridgeHost,
} from "@/components/preview/preview-bridge";

type Listener = (event: MessageEvent<unknown>) => void;

function createHost(): { host: PreviewBridgeHost; emit(event: MessageEvent<unknown>): void; listeners: Set<Listener> } {
  const listeners = new Set<Listener>();
  return {
    host: {
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
    },
    emit(event) {
      for (const listener of listeners) listener(event);
    },
    listeners,
  };
}

function request(operation: "get" | "list" | "set" | "delete", overrides = {}) {
  return {
    artifactVersionId: "version-1",
    operation,
    projectId: "project-1",
    requestId: `request-${operation}`,
    type: "min-atoms-data-request",
    ...(operation === "list" ? {} : { key: "counter" }),
    ...(operation === "set" ? { value: 2 } : {}),
    ...overrides,
  };
}

describe("Preview bridge", () => {
  it("correlates valid get, list, set, and delete responses from the exact iframe", async () => {
    const platformRequest = vi.fn(async (message: { operation: string }) => ({
      data: message.operation === "get" ? 2 : [{ key: "counter", value: 2 }],
    }));
    const iframeWindow = {} as Window;
    const postMessage = vi.fn();
    const harness = createHost();
    const stop = createPreviewBridge({
      artifactVersionId: "version-1",
      host: harness.host,
      iframeWindow: () => iframeWindow,
      platformRequest,
      projectId: "project-1",
      respond: postMessage,
    });

    for (const operation of ["get", "list", "set", "delete"] as const) {
      harness.emit({
        data: request(operation),
        origin: "null",
        source: iframeWindow,
      } as MessageEvent);
    }
    await vi.waitFor(() => expect(platformRequest).toHaveBeenCalledTimes(4));

    expect(postMessage).toHaveBeenCalledTimes(4);
    expect(platformRequest.mock.calls.map(([message]) => message.operation)).toEqual([
      "get",
      "list",
      "set",
      "delete",
    ]);
    stop();
    expect(harness.listeners).toHaveLength(0);
  });

  it("sends safe correlated responses and rejects malformed, wrong-source, cross-project, wrong-version, and oversized requests", async () => {
    const iframeWindow = {} as Window;
    const wrongWindow = {} as Window;
    const postMessage = vi.fn();
    const platformRequest = vi.fn(async () => ({ data: 2 }));
    const harness = createHost();
    const stop = createPreviewBridge({
      artifactVersionId: "version-1",
      host: harness.host,
      iframeWindow: () => iframeWindow,
      platformRequest,
      projectId: "project-1",
      respond: postMessage,
    });

    harness.emit({ data: request("get"), origin: "null", source: wrongWindow } as MessageEvent);
    harness.emit({ data: { type: "min-atoms-data-request" }, origin: "null", source: iframeWindow } as MessageEvent);
    harness.emit({ data: request("get", { projectId: "project-2" }), origin: "null", source: iframeWindow } as MessageEvent);
    harness.emit({ data: request("get", { artifactVersionId: "version-2" }), origin: "null", source: iframeWindow } as MessageEvent);
    harness.emit({ data: request("set", { value: "x".repeat(16_385) }), origin: "null", source: iframeWindow } as MessageEvent);
    harness.emit({ data: request("get"), origin: "http://localhost:3000", source: iframeWindow } as MessageEvent);
    await Promise.resolve();

    expect(platformRequest).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();

    harness.emit({ data: request("get"), origin: "null", source: iframeWindow } as MessageEvent);
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
    expect(postMessage).toHaveBeenCalledWith(iframeWindow, {
      data: 2,
      ok: true,
      requestId: "request-get",
      type: "min-atoms-data-response",
    });
    stop();
  });

  it("rejects data access after the Preview document has navigated", async () => {
    const iframeWindow = {} as Window;
    const platformRequest = vi.fn(async () => ({ data: 2 }));
    const harness = createHost();
    const stop = createPreviewBridge({
      artifactVersionId: "version-1",
      host: harness.host,
      iframeWindow: () => iframeWindow,
      isActiveDocument: () => false,
      platformRequest,
      projectId: "project-1",
    });

    harness.emit({
      data: request("get"),
      origin: "null",
      source: iframeWindow,
    } as MessageEvent);
    await Promise.resolve();

    expect(platformRequest).not.toHaveBeenCalled();
    stop();
  });
});
