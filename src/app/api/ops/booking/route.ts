import { NextResponse } from "next/server";
import { z } from "zod";
import { isOpsAuthed } from "@/lib/ops/auth";
import { billing } from "@/lib/billing";
import { PAYMENT_METHODS } from "@/lib/billing/types";
import { computeQuote, PACKAGES, type PackageId } from "@/lib/pricing";

export const dynamic = "force-dynamic";

/**
 * Book a walk-in at the counter: the same invoice the app creates, plus the
 * payment if it's already been taken.
 *
 * Two things this deliberately does NOT do, both because the counter's version
 * of a booking differs from the customer's in exactly these ways:
 *
 *  - No validation code. The code exists so staff can check a family in against
 *    a booking made elsewhere, and the ops monitor holds a session at "waiting"
 *    while one is present. A walk-in is at the desk, so its timer should run
 *    from the invoice — see CreateBookingInput.validationCode.
 *  - No new customer for a number we already know. The billing adapter looks the
 *    phone up and reuses the party, so re-booking a regular family adds an
 *    invoice against the customer they already have, never a duplicate of them.
 */
const bookingSchema = z
  .object({
    name: z.string().trim().min(2, "Enter the customer's name").max(60),
    phone: z.string().regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit mobile number"),
    packageId: z.enum(PACKAGES.map((p) => p.id) as [PackageId, ...PackageId[]]),
    kids: z.number().int().min(1).max(15),
    extraAdults: z.number().int().min(0).max(20),
    childSocks: z.number().int().min(0).max(30),
    adultSocks: z.number().int().min(0).max(30),
    kidNames: z.array(z.string().trim().max(40)).max(15).default([]),
    /** True = money already taken; record it against the invoice right away. */
    paid: z.boolean().default(false),
    method: z.enum(PAYMENT_METHODS).optional(),
    transactionRef: z.string().trim().max(60).optional(),
  })
  .refine((v) => !v.paid || v.method != null, {
    message: "Pick how they paid",
    path: ["method"],
  });

export async function POST(req: Request) {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let input: z.infer<typeof bookingSchema>;
  try {
    input = bookingSchema.parse(await req.json());
  } catch (err) {
    const message = err instanceof z.ZodError ? err.issues[0]?.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  // Priced server-side from the same catalogue the customer form uses, so a
  // counter booking and an app booking of the same selection cost the same.
  const quote = computeQuote(input);
  const kidNames = input.kidNames.map((n) => n.trim()).filter(Boolean);

  let booking;
  try {
    booking = await billing.createBooking({
      customer: { name: input.name, phone: input.phone, kidNames },
      lines: quote.lines,
    });
  } catch (err) {
    console.error("counter booking failed:", err);
    return NextResponse.json(
      { error: "Couldn't create the invoice in Swipe — please try again" },
      { status: 502 }
    );
  }

  // Payment is a second call, and it can fail on its own. The invoice exists
  // either way, so a failure here reports "booked but not recorded" rather than
  // losing the booking — the card's own Collect button is then the way in.
  if (input.paid) {
    try {
      await billing.recordPayment({
        ref: booking.ref,
        amount: quote.total,
        method: input.method!,
        transactionRef: input.transactionRef,
      });
    } catch (err) {
      console.error("counter booking payment failed:", err);
      return NextResponse.json(
        {
          invoiceNumber: booking.invoiceNumber,
          total: quote.total,
          paid: false,
          amountDue: quote.total,
          warning: `${booking.invoiceNumber} was created, but the payment didn't record. Collect it from the card.`,
        },
        { status: 207 }
      );
    }
  }

  return NextResponse.json({
    invoiceNumber: booking.invoiceNumber,
    total: quote.total,
    paid: input.paid,
    amountDue: input.paid ? 0 : quote.total,
  });
}
