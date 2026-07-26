"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";

import type { ArtifactFiles } from "@/lib/generation/types";
import {
  createPreviewBridge,
  type PreviewBridgeHost,
} from "@/components/preview/preview-bridge";
import type { PreviewDataRequest } from "@/lib/generated-app-data/contract";
import { readArtifactManifest } from "@/lib/generation/manifest";
import { UI_PRESETS } from "@/lib/generation/ui-presets";

type PreviewFrameProps = {
  artifactVersionId: string;
  files: ArtifactFiles;
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

export function PreviewFrame({ artifactVersionId, files, projectId }: PreviewFrameProps) {
  const bridgeReadyRef = useRef(false);
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

  useEffect(() => {
    const stop = createPreviewBridge({
      artifactVersionId,
      host: window as unknown as PreviewBridgeHost,
      iframeWindow: () => iframeRef.current?.contentWindow ?? null,
      platformRequest: requestGeneratedAppData,
      projectId,
    });
    bridgeReadyRef.current = true;
    announceBridgeReady();
    return () => {
      bridgeReadyRef.current = false;
      stop();
    };
  }, [announceBridgeReady, artifactVersionId, projectId]);

  return (
    <div className="preview-frame-wrap">
      <div className="preview-toolbar">
        <span className="preview-registration" aria-hidden="true">A-01</span>
        <span>Interactive Preview</span>
        <span className="preview-lock">Sandboxed · controlled assets</span>
      </div>
      <iframe
        className="preview-frame"
        onLoad={announceBridgeReady}
        ref={iframeRef}
        referrerPolicy="no-referrer"
        sandbox={PREVIEW_SANDBOX}
        srcDoc={srcDoc}
        title="Interactive generated preview"
      />
    </div>
  );
}

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

export function buildPreviewDocument(
  files: ArtifactFiles,
  context: { artifactVersionId: string; projectId: string } = {
    artifactVersionId: "preview-artifact",
    projectId: "preview-project",
  },
): string {
  const manifest = readArtifactManifest(files["manifest.json"], {
    allowLegacyUi: true,
  });
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

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}">${presetLink}<style>${files["styles.css"].replaceAll("</style", "<\\/style")}</style></head><body>${files["index.html"]}<script>${buildGeneratedAppDataClient(context).replaceAll("</script", "<\\/script")}</script><script>${files["app.js"].replaceAll("</script", "<\\/script")}</script></body></html>`;
}
