import {
  parsePreviewDataRequest,
  type PreviewDataRequest,
} from "@/lib/generated-app-data/contract";

export type PreviewBridgeHost = {
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
};

type PreviewBridgeResponse = {
  data?: unknown;
  error?: "request-failed";
  ok: boolean;
  requestId: string;
  type: "min-atoms-data-response";
};

type PreviewBridgeOptions = {
  artifactVersionId: string;
  host: PreviewBridgeHost;
  iframeWindow: () => Window | null;
  platformRequest: (request: PreviewDataRequest) => Promise<{ data?: unknown }>;
  projectId: string;
  respond?: (target: Window, response: PreviewBridgeResponse) => void;
};

function sendResponse(target: Window, response: PreviewBridgeResponse): void {
  target.postMessage(response, "*");
}

export function createPreviewBridge(options: PreviewBridgeOptions): () => void {
  const respond = options.respond ?? sendResponse;

  const onMessage = async (event: MessageEvent<unknown>) => {
    const source = event.source;
    if (
      !source ||
      source !== options.iframeWindow() ||
      event.origin !== "null"
    ) {
      return;
    }

    const request = parsePreviewDataRequest(event.data);
    if (
      !request ||
      request.projectId !== options.projectId ||
      request.artifactVersionId !== options.artifactVersionId
    ) {
      return;
    }

    try {
      const result = await options.platformRequest(request);
      respond(source as Window, {
        data: result.data,
        ok: true,
        requestId: request.requestId,
        type: "min-atoms-data-response",
      });
    } catch {
      respond(source as Window, {
        error: "request-failed",
        ok: false,
        requestId: request.requestId,
        type: "min-atoms-data-response",
      });
    }
  };

  options.host.addEventListener("message", onMessage);
  return () => options.host.removeEventListener("message", onMessage);
}
