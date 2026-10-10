"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { VersionDTO } from "@min-atoms/protocol";
import { ArrowLeft, FolderX } from "lucide-react";

import { Button } from "@/components/ui/button";
import { createApiSource } from "@/lib/client/api";
import { createMockSource } from "@/lib/client/mock";
import type { RunMode, WorkbenchSource } from "@/lib/client/source";
import {
  WorkbenchStore,
  buildTimeline,
  findActiveRun,
  hasBlockingRun,
  nextVersionNumber,
  type RunViewData,
} from "@/lib/client/store";
import { cn } from "@/lib/utils";

import { ConversationPane } from "./conversation-pane";
import { PreviewPane } from "./preview-pane";
import { WorkbenchTopBar, type WorkbenchTab } from "./project-header";
import { RestoreDialog, type RestoreTarget } from "./restore-dialog";
import { WorkbenchSkeleton } from "./workbench-skeleton";

// Mock gates require development AND the flag (T15 convention): production
// builds always use the real API and real authentication.
const MOCK_ENABLED = process.env.NODE_ENV === "development" && process.env.NEXT_PUBLIC_MOCK_STREAM === "1";

export function WorkbenchScreen({ projectId }: { projectId: string }) {
  const searchParams = useSearchParams();
  const scenario = searchParams.get("scenario") ?? "live";
  const source = useMemo<WorkbenchSource>(
    () => (MOCK_ENABLED ? createMockSource(projectId, scenario) : createApiSource(projectId)),
    [projectId, scenario],
  );
  const [store] = useState(() => new WorkbenchStore(projectId));
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const router = useRouter();

  const [mobileTab, setMobileTab] = useState<WorkbenchTab>("chat");
  // Explicit "own send" signal for MessageList: sending while scrolled up
  // jumps to the bottom (ux 6.3); streamed updates alone never steal scroll.
  const [sendSignal, setSendSignal] = useState(0);
  const [restoreTarget, setRestoreTarget] = useState<RestoreTarget | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  // Initial history load, then subscribe to the event stream with `after`
  // resume; the store drops any event id at or below the history cursor.
  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    source
      .loadProject()
      .then((detail) => {
        if (disposed) return;
        store.loadDetail(detail);
        unsubscribe = source.subscribe(detail.lastEventId, (id, event) => store.applyEvent(id, event));
      })
      .catch(() => {
        if (!disposed) store.loadFailed();
      });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [source, store]);

  // VM polling (ux §7.8/§8): check every 10s; call ensure on the first "up"
  // and again whenever the environment comes back from being down.
  useEffect(() => {
    if (state.status !== "ready") return;
    let cancelled = false;
    let waking = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wake = async () => {
      if (waking) return;
      waking = true;
      try {
        await source.ensure();
        const url = await source.getPreviewUrl();
        if (!cancelled) store.setPreviewReady(url);
      } catch {
        // The next poll retries the wake-up.
      }
      waking = false;
    };
    const poll = async () => {
      let up = false;
      try {
        up = await source.getVmUp();
      } catch {
        up = false;
      }
      if (cancelled) return;
      store.setVmUp(up);
      // Retry the wake on every 10s poll while the preview is not ready: a
      // failed ensure/getPreviewUrl must not leave the pane spinning forever.
      // setVmUp(false) already resets previewReady, so a down->up transition
      // re-wakes through the same condition; `waking` serializes attempts.
      if (up && !store.getSnapshot().previewReady) void wake();
      timer = setTimeout(() => void poll(), 10_000);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [source, store, state.status]);

  const handleSend = async (content: string, mode: RunMode) => {
    setSendSignal((value) => value + 1);
    const tempId = store.addDraft(content, mode);
    try {
      const { message, run } = await source.sendMessage(content, mode);
      store.confirmDraft(tempId, message, run);
    } catch {
      store.failDraft(tempId);
    }
  };

  const handleRetryDraft = (tempId: string) => {
    const draft = store.getSnapshot().drafts.find((d) => d.tempId === tempId);
    if (!draft || draft.state === "sending") return;
    store.markDraftSending(tempId);
    source
      .sendMessage(draft.content, draft.mode)
      .then(({ message, run }) => store.confirmDraft(tempId, message, run))
      .catch(() => store.failDraft(tempId));
  };

  const handleStop = (runId: string) => {
    store.markStopRequested(runId);
    setTimeout(() => store.markStopTimedOut(runId), 10_000);
    void source.stopRun(runId).catch(() => undefined);
  };

  const handleRestoreRequest = (versionId: string) => {
    if (hasBlockingRun(store.getSnapshot())) return;
    const version = store.getSnapshot().versions.find((v) => v.id === versionId);
    if (!version || version.id === store.getSnapshot().currentVersionId) return;
    setRestoreError(null);
    setRestoreTarget({ versionId: version.id, number: version.number, nextNumber: nextVersionNumber(store.getSnapshot()) });
  };

  const handleRestoreConfirm = async () => {
    if (!restoreTarget) return;
    setRestoreBusy(true);
    setRestoreError(null);
    try {
      const created: VersionDTO = await source.restoreVersion(restoreTarget.versionId);
      store.applyRestore(created, restoreTarget.number);
      setRestoreTarget(null);
    } catch {
      setRestoreError("恢复失败，请重试");
    } finally {
      setRestoreBusy(false);
    }
  };

  const handleDelete = async () => {
    await source.deleteProject();
    router.push("/");
  };

  if (state.status === "loading") return <WorkbenchSkeleton />;
  if (state.status === "error") {
    return (
      <div className="wb-root bench-mat flex h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
        <span className="flex size-12 items-center justify-center rounded-2xl bg-white text-zinc-400 shadow-[var(--shadow-card)]">
          <FolderX className="size-6" aria-hidden="true" />
        </span>
        <p className="text-[15px] font-medium text-zinc-700" role="alert">
          项目加载失败或不存在
        </p>
        <Button type="button" variant="outline" size="sm" onClick={() => router.push("/")}>
          <ArrowLeft className="size-3.5" aria-hidden="true" />
          返回首页
        </Button>
      </div>
    );
  }

  const timeline = buildTimeline(state);
  const activeRun = findActiveRun(state);
  const blocked = hasBlockingRun(state);

  const actions = {
    onRetryDraft: handleRetryDraft,
    onFix: () => void handleSend("修复上面的问题", "build"),
    onRetryRun: (run: RunViewData) => {
      const original = state.messages.find((message) => message.id === run.userMessageId);
      if (original) void handleSend(original.content, original.mode);
    },
    onRestoreRequest: handleRestoreRequest,
  };

  const building = activeRun?.mode === "build";

  return (
    <div className="wb-root flex h-dvh flex-col overflow-hidden bg-white text-zinc-900">
      <WorkbenchTopBar
        className="lg:hidden"
        projectName={state.projectName}
        deleteBlocked={blocked}
        onBack={() => router.push("/")}
        onDelete={handleDelete}
        tab={mobileTab}
        onTabChange={setMobileTab}
        previewLive={building}
      />
      <main id="main-content" className="flex min-h-0 min-w-0 flex-1">
        <ConversationPane
          className={cn(mobileTab === "chat" ? "flex" : "hidden", "lg:flex")}
          state={state}
          timeline={timeline}
          activeRun={activeRun}
          restoreBlocked={blocked}
          deleteBlocked={blocked}
          onBack={() => router.push("/")}
          onDelete={handleDelete}
          onSend={(content, mode) => void handleSend(content, mode)}
          onStop={handleStop}
          sendSignal={sendSignal}
          actions={actions}
        />
        <PreviewPane
          className={cn(mobileTab === "preview" ? "flex" : "hidden", "lg:flex")}
          vmUp={state.vmUp}
          previewUrl={state.previewUrl}
          previewReady={state.previewReady}
          previewKey={state.previewKey}
          running={building}
          versions={state.versions}
          currentVersionId={state.currentVersionId}
          restoreBlocked={blocked}
          onRefresh={() => store.refreshPreview()}
          onRestoreRequest={(version) => handleRestoreRequest(version.id)}
        />
      </main>
      <RestoreDialog
        target={restoreTarget}
        busy={restoreBusy}
        error={restoreError}
        onCancel={() => setRestoreTarget(null)}
        onConfirm={() => void handleRestoreConfirm()}
      />
    </div>
  );
}
