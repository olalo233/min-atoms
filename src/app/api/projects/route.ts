import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth/session";
import {
  createProjectWithBuildRequest,
  listOwnedProjects,
} from "@/lib/projects/repository";

const createProjectSchema = z.object({
  buildRequest: z.string().max(20_000),
});

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }

  const projects = await listOwnedProjects(user.id);
  return NextResponse.json({ projects });
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      { error: "A valid JSON body is required." },
      { status: 400 },
    );
  }

  const parsed = createProjectSchema.safeParse(payload);
  if (!parsed.success || !parsed.data.buildRequest.trim()) {
    return NextResponse.json(
      { error: "Build request cannot be empty." },
      { status: 400 },
    );
  }

  const result = await createProjectWithBuildRequest(
    user.id,
    parsed.data.buildRequest,
  );
  return NextResponse.json(result, { status: 201 });
}
