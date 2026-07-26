import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { listOwnedGeneratedAppData } from "@/lib/generated-app-data/repository";

type GeneratedAppDataRouteContext = {
  params: Promise<{ projectId: string }>;
};

export async function GET(
  _request: Request,
  context: GeneratedAppDataRouteContext,
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }

  const { projectId } = await context.params;
  const items = await listOwnedGeneratedAppData(user.id, projectId);
  if (!items) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }
  return NextResponse.json({ items });
}
