import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import {
  isBoundedGeneratedAppDataValue,
  isGeneratedAppDataKey,
} from "@/lib/generated-app-data/contract";
import {
  deleteOwnedGeneratedAppData,
  getOwnedGeneratedAppData,
  setOwnedGeneratedAppData,
} from "@/lib/generated-app-data/repository";

type GeneratedAppDataKeyRouteContext = {
  params: Promise<{ key: string; projectId: string }>;
};

async function getAuthenticatedContext(context: GeneratedAppDataKeyRouteContext) {
  const user = await getCurrentUser();
  const params = await context.params;
  return { params, user };
}

export async function GET(
  _request: Request,
  context: GeneratedAppDataKeyRouteContext,
) {
  const { params, user } = await getAuthenticatedContext(context);
  if (!user) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }
  if (!isGeneratedAppDataKey(params.key)) {
    return NextResponse.json({ error: "Generated App Data key is invalid." }, { status: 400 });
  }

  const lookup = await getOwnedGeneratedAppData(
    user.id,
    params.projectId,
    params.key,
  );
  if (!lookup.projectFound) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }
  return NextResponse.json({ value: lookup.value ?? null });
}

export async function PUT(
  request: Request,
  context: GeneratedAppDataKeyRouteContext,
) {
  const { params, user } = await getAuthenticatedContext(context);
  if (!user) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }
  if (!isGeneratedAppDataKey(params.key)) {
    return NextResponse.json({ error: "Generated App Data key is invalid." }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "A valid JSON body is required." },
      { status: 400 },
    );
  }

  const value = body && typeof body === "object" && !Array.isArray(body)
    ? (body as { value?: unknown }).value
    : undefined;
  if (!isBoundedGeneratedAppDataValue(value)) {
    return NextResponse.json({ error: "Generated App Data value is invalid." }, { status: 400 });
  }

  const stored = await setOwnedGeneratedAppData(
    user.id,
    params.projectId,
    params.key,
    value,
  );
  if (stored === undefined) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }
  return NextResponse.json({ value: stored });
}

export async function DELETE(
  _request: Request,
  context: GeneratedAppDataKeyRouteContext,
) {
  const { params, user } = await getAuthenticatedContext(context);
  if (!user) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }
  if (!isGeneratedAppDataKey(params.key)) {
    return NextResponse.json({ error: "Generated App Data key is invalid." }, { status: 400 });
  }

  const deleted = await deleteOwnedGeneratedAppData(user.id, params.projectId, params.key);
  if (deleted === null) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }
  return NextResponse.json({ deleted });
}
