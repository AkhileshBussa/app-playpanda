import { NextResponse } from "next/server";
import { isOpsAuthed } from "@/lib/ops/auth";
import { getBoardNudge } from "@/lib/ops/state";

export const dynamic = "force-dynamic";

/**
 * The board's cheap change signal: one Redis GET, no Swipe calls. The
 * dashboard checks this every few seconds and only refetches the (expensive)
 * session list when the value moves.
 */
export async function GET() {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ v: await getBoardNudge() });
}
