import { NextResponse } from "next/server";
import { isOpsAuthed } from "@/lib/ops/auth";
import { billing } from "@/lib/billing";
import { listLinkedSaleInvoices } from "@/lib/members/db";

export const dynamic = "force-dynamic";

/**
 * Today's membership SALE invoices from Swipe, for the new-membership form's
 * pick-list — so the manager selects the sale they just billed instead of
 * typing its number. `linked` marks invoices already referenced by a
 * membership (still selectable: one invoice can carry two plans).
 */
export async function GET() {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const [invoices, linked] = await Promise.all([
      billing.listTodayMembershipSales(),
      // Missing link data only costs the "linked" tag — don't fail the list.
      listLinkedSaleInvoices().catch((err) => {
        console.error("failed to read linked sale invoices:", err);
        return [] as string[];
      }),
    ]);

    const linkedSet = new Set(linked);
    return NextResponse.json({
      invoices: invoices.map((inv) => ({ ...inv, linked: linkedSet.has(inv.invoiceNumber) })),
    });
  } catch (err) {
    console.error("membership sale-invoice lookup failed:", err);
    return NextResponse.json(
      { error: "Couldn't load today's invoices from Swipe" },
      { status: 502 }
    );
  }
}
