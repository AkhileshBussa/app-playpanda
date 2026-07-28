import { NextResponse } from "next/server";
import { billing } from "@/lib/billing";
import { isOpsAuthed } from "@/lib/ops/auth";

export const dynamic = "force-dynamic";

/** Today's sales rollup for the ops monitor header. */
export async function GET() {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    return NextResponse.json(await billing.getTodaySales());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: `Failed to fetch sales: ${message}` }, { status: 500 });
  }
}
