import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { unauthorized } from "@/lib/server/http";
import { isVmUp } from "@/lib/server/vm";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return unauthorized();
  }

  return NextResponse.json({ up: await isVmUp() });
}
