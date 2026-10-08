import { runAfterResponse } from "./after";
import { getManagerClient, MANAGER_TIMEOUTS } from "./manager";

/**
 * Asks the manager to run the project's queued runs. Kick returns immediately,
 * so a failure only means the queue starts later (manager retries on startup).
 */
export async function kickProject(projectId: string, previewLabel: string): Promise<void> {
  try {
    await getManagerClient().kick(projectId, previewLabel, MANAGER_TIMEOUTS.kick);
  } catch (error) {
    console.error(`Manager kick failed for project ${projectId}:`, error);
  }
}

/** Kick after the response so creating a project or a message stays fast. */
export function scheduleKick(projectId: string, previewLabel: string): void {
  runAfterResponse(() => kickProject(projectId, previewLabel));
}
