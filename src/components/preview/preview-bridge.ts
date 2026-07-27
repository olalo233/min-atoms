import {
  parsePreviewDataRequest,
  type PreviewDataRequest,
} from "@/lib/generated-app-data/contract";
import {
  parseRuntimeDiagnostic,
  type RuntimeDiagnostic,
} from "@/lib/generation/runtime-diagnostic";

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
  isActiveDocument?: () => boolean;
  platformRequest: (request: PreviewDataRequest) => Promise<{ data?: unknown }>;
  projectId: string;
  respond?: (target: Window, response: PreviewBridgeResponse) => void;
  runtimeReport?: (diagnostic: RuntimeDiagnostic) => Promise<void>;
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
      options.isActiveDocument?.() === false ||
      event.origin !== "null"
    ) {
      return;
    }

    const runtimeDiagnostic = parseRuntimeDiagnostic(event.data);
    if (
      runtimeDiagnostic &&
      runtimeDiagnostic.projectId === options.projectId &&
      runtimeDiagnostic.artifactVersionId === options.artifactVersionId
    ) {
      await options.runtimeReport?.(runtimeDiagnostic);
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
