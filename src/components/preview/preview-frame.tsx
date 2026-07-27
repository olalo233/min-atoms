"use client";

import { memo, useCallback, useEffect, useMemo, useRef } from "react";

import type { ArtifactFiles } from "@/lib/generation/types";
import {
  createPreviewBridge,
  type PreviewBridgeHost,
} from "@/components/preview/preview-bridge";
import type { PreviewDataRequest } from "@/lib/generated-app-data/contract";
import { readArtifactManifest } from "@/lib/generation/manifest";
import type { RuntimeDiagnostic } from "@/lib/generation/runtime-diagnostic";
import type { GenerationSnapshot } from "@/lib/generation/types";
import { UI_PRESETS } from "@/lib/generation/ui-presets";

export type PreviewFrameProps = {
  artifactVersionId: string;
  files: ArtifactFiles;
  onRuntimeRepairQueued?: (snapshot: GenerationSnapshot) => void;
  projectId: string;
};

export const PREVIEW_SANDBOX = "allow-scripts";

async function requestGeneratedAppData(request: PreviewDataRequest): Promise<{ data?: unknown }> {
  const basePath = `/api/projects/${encodeURIComponent(request.projectId)}/generated-app-data`;
  const path = request.operation === "list"
    ? basePath
    : `${basePath}/${encodeURIComponent(request.key)}`;
  const response = await fetch(path, {
    body: request.operation === "set" ? JSON.stringify({ value: request.value }) : undefined,
    headers: request.operation === "set" ? { "content-type": "application/json" } : undefined,
    method: request.operation === "get" || request.operation === "list" ? "GET" : request.operation === "set" ? "PUT" : "DELETE",
  });
  if (!response.ok) {
    throw new Error("Generated App Data request failed.");
  }
  const body = (await response.json()) as { deleted?: boolean; items?: unknown; value?: unknown };
  if (request.operation === "list") {
    return { data: body.items ?? [] };
  }
  if (request.operation === "delete") {
    return { data: body.deleted === true };
  }
  return { data: body.value ?? null };
}

export function arePreviewFramePropsEqual(
  previous: PreviewFrameProps,
  next: PreviewFrameProps,
): boolean {
  return (
    previous.artifactVersionId === next.artifactVersionId &&
    previous.projectId === next.projectId &&
    previous.onRuntimeRepairQueued === next.onRuntimeRepairQueued
  );
}

function PreviewFrameComponent({
  artifactVersionId,
  files,
  onRuntimeRepairQueued,
  projectId,
}: PreviewFrameProps) {
  const bridgeReadyRef = useRef(false);
  const loadedSrcDocRef = useRef<string | null>(null);
  const previewDocumentActiveRef = useRef(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const srcDoc = useMemo(
    () => buildPreviewDocument(files, { artifactVersionId, projectId }),
    [artifactVersionId, files, projectId],
  );
  const announceBridgeReady = useCallback(() => {
    if (!bridgeReadyRef.current) {
      return;
    }
    iframeRef.current?.contentWindow?.postMessage(
      {
        artifactVersionId,
        projectId,
        type: "min-atoms-data-ready",
      },
      "*",
    );
  }, [artifactVersionId, projectId]);
  const handleFrameLoad = useCallback(() => {
    if (loadedSrcDocRef.current === srcDoc) {
      previewDocumentActiveRef.current = false;
      bridgeReadyRef.current = false;
      return;
    }
    loadedSrcDocRef.current = srcDoc;
    previewDocumentActiveRef.current = true;
    announceBridgeReady();
  }, [announceBridgeReady, srcDoc]);
  const reportRuntimeDiagnostic = useCallback(
    async (diagnostic: RuntimeDiagnostic) => {
      try {
        const response = await fetch(
          `/api/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(artifactVersionId)}/runtime-diagnostic`,
          {
            body: JSON.stringify({
              detail: diagnostic.detail,
              kind: diagnostic.kind,
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
          },
        );
        if (!response.ok) return;
        const snapshot = (await response.json()) as GenerationSnapshot;
        onRuntimeRepairQueued?.(snapshot);
      } catch {
        // The Artifact Version remains visible; a transient reporting failure
        // must not replace the real browser error with a platform error.
      }
    },
    [artifactVersionId, onRuntimeRepairQueued, projectId],
  );

  useEffect(() => {
    const alreadyLoaded = loadedSrcDocRef.current === srcDoc;
    previewDocumentActiveRef.current = alreadyLoaded;
    const stop = createPreviewBridge({
      artifactVersionId,
      host: window as unknown as PreviewBridgeHost,
      iframeWindow: () => iframeRef.current?.contentWindow ?? null,
      isActiveDocument: () => previewDocumentActiveRef.current,
      platformRequest: requestGeneratedAppData,
      projectId,
      runtimeReport: reportRuntimeDiagnostic,
    });
    bridgeReadyRef.current = true;
    if (alreadyLoaded) {
      announceBridgeReady();
    }
    return () => {
      bridgeReadyRef.current = false;
      previewDocumentActiveRef.current = false;
      stop();
    };
  }, [
    announceBridgeReady,
    artifactVersionId,
    projectId,
    reportRuntimeDiagnostic,
    srcDoc,
  ]);

  return (
    <div className="preview-frame-wrap">
      <div className="preview-toolbar">
        <span className="preview-registration" aria-hidden="true">A-01</span>
        <span>Interactive Preview</span>
        <span className="preview-lock">Sandboxed · owner-scoped data</span>
      </div>
      <iframe
        className="preview-frame"
        onLoad={handleFrameLoad}
        ref={iframeRef}
        referrerPolicy="no-referrer"
        sandbox={PREVIEW_SANDBOX}
        srcDoc={srcDoc}
        title="Interactive generated preview"
      />
    </div>
  );
}

export const PreviewFrame = memo(
  PreviewFrameComponent,
  arePreviewFramePropsEqual,
);

function buildGeneratedAppDataClient(context: {
  artifactVersionId: string;
  projectId: string;
}): string {
  const serializedContext = JSON.stringify(context).replaceAll("<", "\\u003c");
  return `(function () {
    const context = ${serializedContext};
    let sequence = 0;
    let markReady;
    const ready = new Promise((resolve) => { markReady = resolve; });
    function onReady(event) {
      const message = event.data;
      if (event.source !== window.parent || !message || message.type !== "min-atoms-data-ready" || message.projectId !== context.projectId || message.artifactVersionId !== context.artifactVersionId) return;
      window.removeEventListener("message", onReady);
      markReady();
    }
    window.addEventListener("message", onReady);
    async function request(operation, key, value) {
      await ready;
      return new Promise((resolve, reject) => {
        const requestId = "preview-" + Date.now() + "-" + (++sequence);
        const timeout = window.setTimeout(() => {
          window.removeEventListener("message", onMessage);
          reject(new Error("Generated App Data request timed out."));
        }, 5000);
        function onMessage(event) {
          const response = event.data;
          if (event.source !== window.parent || !response || response.type !== "min-atoms-data-response" || response.requestId !== requestId) return;
          window.clearTimeout(timeout);
          window.removeEventListener("message", onMessage);
          if (response.ok) resolve(response.data);
          else reject(new Error("Generated App Data request failed."));
        }
        window.addEventListener("message", onMessage);
        const message = { ...context, operation, requestId, type: "min-atoms-data-request" };
        if (key !== undefined) message.key = key;
        if (operation === "set") message.value = value;
        window.parent.postMessage(message, "*");
      });
    }
    Object.defineProperty(window, "minAtomsData", {
      configurable: false,
      enumerable: false,
      value: Object.freeze({
        get: (key) => request("get", key),
        list: () => request("list"),
        set: (key, value) => request("set", key, value),
        delete: (key) => request("delete", key),
      }),
      writable: false,
    });
  })();`;
}

function buildRuntimeDiagnosticClient(context: {
  artifactVersionId: string;
  projectId: string;
}): string {
  const serializedContext = JSON.stringify(context).replaceAll("<", "\\u003c");
  return `(function () {
    const context = ${serializedContext};
    let reported = false;
    function describe(value) {
      if (value && typeof value.stack === "string") return value.stack;
      if (value && typeof value.message === "string") return value.message;
      try { return String(value); } catch { return "Unknown runtime failure"; }
    }
    function report(kind, value) {
      if (reported) return;
      reported = true;
      window.parent.postMessage({
        ...context,
        detail: describe(value).slice(0, 640),
        kind,
        type: "min-atoms-runtime-diagnostic",
      }, "*");
    }
    window.addEventListener("error", (event) => {
      report("error", event.error || event.message);
    });
    window.addEventListener("unhandledrejection", (event) => {
      report("unhandledrejection", event.reason);
    });
  })();`;
}

export function buildPreviewDocument(
  files: ArtifactFiles,
  context: { artifactVersionId: string; projectId: string } = {
    artifactVersionId: "preview-artifact",
    projectId: "preview-project",
  },
): string {
  const manifest = readArtifactManifest(files["manifest.json"]);
  if (!manifest) {
    throw new Error("Cannot build a preview from an invalid artifact manifest.");
  }
  const stylesheet = UI_PRESETS[manifest.ui.preset].stylesheet;
  const styleOrigin = stylesheet ? new URL(stylesheet.url).origin : null;
  const contentSecurityPolicy = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    `style-src 'unsafe-inline'${styleOrigin ? ` ${styleOrigin}` : ""}`,
    "img-src data:",
    "connect-src 'none'",
    "font-src 'none'",
    "media-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");

  const presetLink = stylesheet
    ? `<link rel="stylesheet" href="${stylesheet.url}"${stylesheet.integrity ? ` integrity="${stylesheet.integrity}"` : ""} crossorigin="${stylesheet.crossOrigin}">`
    : "";

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><base href="about:srcdoc"><meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}">${presetLink}<style>${files["styles.css"].replaceAll("</style", "<\\/style")}</style></head><body>${files["index.html"]}<script>${buildGeneratedAppDataClient(context).replaceAll("</script", "<\\/script")}</script><script>${buildRuntimeDiagnosticClient(context).replaceAll("</script", "<\\/script")}</script><script>${files["app.js"].replaceAll("</script", "<\\/script")}</script></body></html>`;
}
