import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { wakeRuntime } from "@/lib/server/controller";
import { unauthorized } from "@/lib/server/http";
import { invalidateVmCache } from "@/lib/server/vm";

export const dynamic = "force-dynamic";

export async function POST() {
  if (!await getCurrentUser()) return unauthorized();
  const result = await wakeRuntime();
  invalidateVmCache();
  return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
}
