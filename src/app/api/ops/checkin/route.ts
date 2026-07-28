import { NextResponse } from "next/server";
import { z } from "zod";
import { billing } from "@/lib/billing";
import { isOpsAuthed } from "@/lib/ops/auth";
import { setCheckin, clearCheckin } from "@/lib/ops/state";

export const dynamic = "force-dynamic";

const checkinSchema = z.object({
  /** Session card id (doc handle, possibly #i-suffixed). */
  id: z.string().min(1),
  /** Invoice the code lives on — used to verify server-side. */
  invoiceNumber: z.string().min(1),
  /** The 4-digit code the customer showed. */
  code: z.string().trim().min(1),
});

/**
 * Validate the customer's code and mark the session checked in — this is the
 * moment the play timer starts. The code is compared against the invoice's
 * "Validation Code" field in the billing backend, never trusted from the UI.
 */
export async function POST(req: Request) {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let input: z.infer<typeof checkinSchema>;
  try {
    input = checkinSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    const booking = await billing.getBookingByInvoiceNumber(input.invoiceNumber);
    if (!booking) {
      return NextResponse.json({ error: "Booking not found" }, { status: 404 });
    }
    if (!booking.validationCode) {
      return NextResponse.json(
        { error: "This booking has no code — walk-ins don't need check-in" },
        { status: 400 }
      );
    }
    if (booking.validationCode !== input.code) {
      return NextResponse.json({ error: "Code doesn't match" }, { status: 400 });
    }

    const checkinAt = Date.now();
    await setCheckin(input.id, checkinAt);
    return NextResponse.json({ ok: true, checkinAt });
  } catch (err) {
    console.error("check-in failed:", err);
    return NextResponse.json({ error: "Check-in failed. Please try again." }, { status: 502 });
  }
}

/** Undo a check-in (mis-tap) — the card goes back to "waiting". */
export async function DELETE(req: Request) {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let id: string;
  try {
    const body = await req.json();
    id = z.object({ id: z.string().min(1) }).parse(body).id;
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    await clearCheckin(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("undo check-in failed:", err);
    return NextResponse.json({ error: "Could not undo check-in" }, { status: 502 });
  }
}
