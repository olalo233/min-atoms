import { after, NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth/session";
import {
  getOwnedGenerationSnapshot,
  queueOwnedRuntimeRepair,
} from "@/lib/generation/repository";
import { runGenerationJob } from "@/lib/generation/worker";

export const maxDuration = 120;

const runtimeDiagnosticSchema = z.object({
  detail: z.string().trim().min(1).max(640),
  kind: z.enum(["error", "reload_loop", "unhandledrejection"]),
});

type RouteContext = {
  params: Promise<{ projectId: string; versionId: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }
  const payload = runtimeDiagnosticSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!payload.success) {
    return NextResponse.json(
      { error: "Runtime diagnostic is invalid." },
      { status: 400 },
    );
  }

  const { projectId, versionId } = await context.params;
  const result = await queueOwnedRuntimeRepair(
    user.id,
    projectId,
    versionId,
    `${payload.data.kind}: ${payload.data.detail}`,
  );
  if (!result) {
    return NextResponse.json(
      { error: "Artifact Version not found." },
      { status: 404 },
    );
  }
  if (result.queued) {
    after(() => runGenerationJob(result.jobId));
  }
  const snapshot = await getOwnedGenerationSnapshot(user.id, projectId);
  return NextResponse.json(snapshot, { status: result.queued ? 202 : 200 });
}
