import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import {
  deleteOwnedProject,
  getOwnedProject,
} from "@/lib/projects/repository";

type ProjectRouteContext = {
  params: Promise<{ projectId: string }>;
};

export async function GET(_request: Request, context: ProjectRouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }

  const { projectId } = await context.params;
  const result = await getOwnedProject(user.id, projectId);
  if (!result) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }

  return NextResponse.json(result);
}

export async function DELETE(
  _request: Request,
  context: ProjectRouteContext,
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }

  const { projectId } = await context.params;
  const result = await deleteOwnedProject(user.id, projectId);
  if (result === "not_found") {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }
  if (result === "conflict") {
    return NextResponse.json(
      { error: "Project has an active generation job." },
      { status: 409 },
    );
  }

  return new NextResponse(null, { status: 204 });
}
