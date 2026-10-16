import type { MessageDTO, ProjectDetail, RunDTO, RunEvent, VersionDTO } from "@min-atoms/protocol";

import type { RuntimeStatus, VmStatus } from "../runtime";

/** Message/run mode; protocol exports the schema but not the inferred type. */
export type RunMode = RunDTO["mode"];

/**
 * Data source used by the workbench screen. The real implementation talks to
 * the web API (apps/web/src/lib/client/api.ts); the mock implementation
 * (apps/web/src/lib/client/mock.ts) replays fixtures/events/sample-run.json
 * when NEXT_PUBLIC_MOCK_STREAM=1 so the UI can be reviewed without a manager.
 */
export interface WorkbenchSource {
  loadProject(): Promise<ProjectDetail>;
  /**
   * Subscribe to the project event stream starting after the given
   * project-level event id. Returns an unsubscribe function.
   */
  subscribe(after: number, onEvent: (id: number, event: RunEvent) => void): () => void;
  getVmStatus(): Promise<VmStatus>;
  wakeRuntime(): Promise<RuntimeStatus>;
  /** Wake the project container; resolves once the dev server answers. */
  ensure(): Promise<unknown>;
  /** URL shown in the preview iframe; set as iframe src exactly once. */
  getPreviewUrl(): Promise<string>;
  sendMessage(content: string, mode: RunMode): Promise<{ message: MessageDTO; run: RunDTO }>;
  stopRun(runId: string): Promise<unknown>;
  restoreVersion(versionId: string): Promise<VersionDTO>;
  deleteProject(): Promise<unknown>;
}
