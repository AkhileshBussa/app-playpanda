import { NextResponse } from "next/server";
import { billing } from "@/lib/billing";

/**
 * Read-only diagnostics for the active billing backend (auth + connectivity).
 * Creates/modifies nothing.
 */
export async function GET() {
  const report = await billing.health();
  const ok = report.ok === true;
  return NextResponse.json(report, { status: ok ? 200 : 502 });
}
