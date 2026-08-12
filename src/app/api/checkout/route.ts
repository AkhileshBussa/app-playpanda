import { NextResponse } from "next/server";
import { z } from "zod";
import { computeQuote, PACKAGES, type PackageId } from "@/lib/pricing";
import { billing, type PaymentOrder } from "@/lib/billing";
import { createPaymentOrder, gatewayEnabled } from "@/lib/razorpay";
import { HEARD_FROM_SOURCES } from "@/lib/heardFrom";
import { recordHeardFrom } from "@/lib/staff/db";

const bookingSchema = z.object({
  name: z.string().trim().min(2, "Please enter your name").max(60),
  phone: z.string().regex(/^[6-9]\d{9}$/, "Please enter a valid 10-digit mobile number"),
  packageId: z.enum(PACKAGES.map((p) => p.id) as [PackageId, ...PackageId[]]),
  kids: z.number().int().min(1).max(15),
  extraAdults: z.number().int().min(0).max(20),
  childSocks: z.number().int().min(0).max(30),
  adultSocks: z.number().int().min(0).max(30),
  kidNames: z.array(z.string().trim().max(40)).max(15).optional(),
  /** False = customer chose to pay at the counter; don't create a gateway order. */
  payNow: z.boolean().optional(),
  /** "How did you hear about us?" — the form only offers it to new customers. */
  heardFrom: z.array(z.enum(HEARD_FROM_SOURCES)).max(HEARD_FROM_SOURCES.length).default([]),
});

export async function POST(req: Request) {
  let input: z.infer<typeof bookingSchema>;
  try {
    input = bookingSchema.parse(await req.json());
  } catch (err) {
    const message = err instanceof z.ZodError ? err.issues[0]?.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  // Price is always computed server-side; the client total is display-only.
  const quote = computeQuote(input);
  const kidNames = (input.kidNames ?? []).map((n) => n.trim()).filter(Boolean);

  // 4-digit code the customer shows and the counter matches against the invoice.
  const validationCode = String(Math.floor(1000 + Math.random() * 9000));
  const paymentsEnabled = process.env.NEXT_PUBLIC_PAYMENTS_ENABLED !== "false";

  try {
    const booking = await billing.createBooking({
      customer: { name: input.name, phone: input.phone, kidNames },
      lines: quote.lines,
      validationCode,
    });

    // The marketing answer is best-effort: losing it must never lose a booking.
    if (input.heardFrom.length) {
      try {
        await recordHeardFrom({
          phone: input.phone,
          name: input.name,
          invoice: booking.invoiceNumber,
          sources: [...input.heardFrom],
        });
      } catch (err) {
        console.error("heard-from save failed:", err);
      }
    }

    // The invoice now exists in the billing backend (unpaid). With payments
    // on, also create a Razorpay order (our own account — see lib/razorpay)
    // so the browser can open checkout. Any failure here degrades to
    // pay-at-counter — the booking is already saved and must never be lost
    // to a payment hiccup.
    let payment: PaymentOrder | null = null;
    if (paymentsEnabled && input.payNow !== false && gatewayEnabled()) {
      try {
        payment = await createPaymentOrder(quote.total, booking.invoiceNumber);
      } catch (err) {
        console.error("payment order creation failed (falling back to counter):", err);
      }
    }


    return NextResponse.json({
      skipPayment: payment == null,
      payment,
      invoiceNumber: booking.invoiceNumber,
      ref: booking.ref,
      validationCode,
      total: quote.total,
    });
  } catch (err) {
    console.error("checkout failed:", err);
    return NextResponse.json(
      { error: "We couldn't create your booking. Please try again or ask at the counter." },
      { status: 502 }
    );
  }
}
