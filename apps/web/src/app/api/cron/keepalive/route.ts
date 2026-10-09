import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await getDb().execute(sql`SELECT 1`);
    return NextResponse.json(
      { ok: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
  }
}
