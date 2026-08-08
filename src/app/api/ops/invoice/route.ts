import { NextResponse } from "next/server";
import { isOpsAuthed } from "@/lib/ops/auth";
import { billing } from "@/lib/billing";

export const dynamic = "force-dynamic";

/**
 * The line items behind one session card, for the ops monitor's detail view:
 * what was actually billed on that invoice, and what's still owed.
 */
export async function GET(req: Request) {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const number = new URL(req.url).searchParams.get("number")?.trim();
  if (!number) {
    return NextResponse.json({ error: "Missing invoice number" }, { status: 400 });
  }

  try {
    const booking = await billing.getBookingByInvoiceNumber(number);
    if (!booking) {
      return NextResponse.json({ error: `No invoice ${number} found` }, { status: 404 });
    }
    // validationCode is deliberately dropped — it stays server-side.
    return NextResponse.json({
      invoiceNumber: booking.invoiceNumber,
      customerName: booking.customerName,
      amount: booking.amount,
      paid: booking.paid,
      lines: booking.lines,
    });
  } catch (err) {
    console.error("ops invoice lookup failed:", err);
    return NextResponse.json({ error: "Couldn't load the invoice from Swipe" }, { status: 502 });
  }
}
