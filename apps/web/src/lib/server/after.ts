import { after } from "next/server";

/**
 * Runs a task after the response is sent. `after()` extends the function lifetime
 * on Vercel, so the deferred kick is not cut off with the response.
 */
export function runAfterResponse(task: () => Promise<void>): void {
  after(async () => {
    try {
      await task();
    } catch (error) {
      console.error("Deferred task failed:", error);
    }
  });
}
