import { NextResponse } from "next/server";
import { z } from "zod";
import { applyDiscount, computeQuote, PACKAGES, type PackageId, type Quote } from "@/lib/pricing";
import { billing, type PaymentOrder } from "@/lib/billing";
import { createPaymentOrder, gatewayEnabled } from "@/lib/razorpay";
import { HEARD_FROM_SOURCES } from "@/lib/heardFrom";
import { setHeardFrom, upsertCustomer } from "@/lib/customers/db";
import { quoteMirrorLines, recordInvoice } from "@/lib/invoices/db";
import { createPendingBooking, pendingConfigured } from "@/lib/bookings/pending";
import { dbConfigured } from "@/lib/pg";
import { bumpBoard } from "@/lib/ops/state";
import {
  attachInvoice,
  evaluateCode,
  redeem,
  releaseRedemption,
} from "@/lib/discounts/db";
import { DiscountError, type DiscountCode } from "@/lib/discounts/types";
import { CUSTOMER_CODES_ENABLED } from "@/lib/discounts/enabled";

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
  /** Discount code the customer typed, if any. Re-checked here, never trusted. */
  discountCode: z.string().trim().min(1).max(40).optional(),
});

/**
 * Two flows, split on whether money is being taken NOW:
 *
 *  - PAY FIRST (online): nothing is created in Swipe here. The priced booking
 *    waits in pending_bookings and the response carries only the gateway
 *    order; the invoice is built when the payment actually captures
 *    (/api/payment/verify or the webhook). A failed or abandoned payment
 *    leaves no invoice behind — that's the point.
 *
 *  - INVOICE FIRST (pay at counter, or the gateway/database is down): the
 *    unpaid invoice IS the booking, created immediately, settled at the desk.
 */
export async function POST(req: Request) {
  let input: z.infer<typeof bookingSchema>;
  try {
    input = bookingSchema.parse(await req.json());
  } catch (err) {
    const message = err instanceof z.ZodError ? err.issues[0]?.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  // Price is always computed server-side; the client total is display-only.
  let quote: Quote = computeQuote(input);
  const kidNames = (input.kidNames ?? []).map((n) => n.trim()).filter(Boolean);

  // Evaluate (don't spend) the code: both flows need the discounted price,
  // but only the invoice-first flow reserves the use here — the pay-first
  // flow records the redemption when the paid invoice is actually built.
  let discountCode: DiscountCode | null = null;
  if (input.discountCode) {
    // The form hides the box when codes are off; this is the half that matters,
    // since a hidden field is no protection against a hand-made request.
    if (!CUSTOMER_CODES_ENABLED || !dbConfigured()) {
      return NextResponse.json({ error: "That code isn't valid" }, { status: 400 });
    }
    try {
      const { code, amount } = await evaluateCode({
        code: input.discountCode,
        phone: input.phone,
        gross: quote.total,
        channel: "online",
      });
      quote = applyDiscount(quote, { code: code.code, amount });
      discountCode = code;
    } catch (err) {
      if (err instanceof DiscountError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      console.error("discount evaluation failed:", err);
      return NextResponse.json(
        { error: "We couldn't apply that code. Please try again or ask at the counter." },
        { status: 502 }
      );
    }
  }

  // 4-digit code the customer shows and the counter matches against the invoice.
  const validationCode = String(Math.floor(1000 + Math.random() * 9000));
  const paymentsEnabled = process.env.NEXT_PUBLIC_PAYMENTS_ENABLED !== "false";
  const payFirst =
    paymentsEnabled && input.payNow !== false && gatewayEnabled() && pendingConfigured();

  // ── Pay first ──────────────────────────────────────────────────────────────
  if (payFirst) {
    try {
      const payment: PaymentOrder = await createPaymentOrder(
        quote.total,
        // No invoice exists yet — the receipt is a placeholder; fulfilment
        // finds the booking by ORDER id, never by receipt.
        `PENDING-${validationCode}-${Date.now() % 1_000_000}`,
        quote.discount
      );
      await createPendingBooking(payment.orderId, {
        customer: { name: input.name.trim(), phone: input.phone, kidNames },
        lines: quote.lines,
        grossInr: quote.gross,
        discountInr: quote.discount?.amount ?? 0,
        netInr: quote.total,
        validationCode,
        discount: discountCode ? { codeId: discountCode.id, code: discountCode.code } : null,
        heardFrom: [...input.heardFrom],
      });

      return NextResponse.json({
        pending: true,
        skipPayment: false,
        payment,
        total: quote.total,
        gross: quote.gross,
        discount: quote.discount ?? null,
      });
    } catch (err) {
      // Gateway or database trouble — degrade to the invoice-first flow below
      // rather than losing the booking. Worst case the family pays at the desk.
      console.error("pay-first setup failed (falling back to counter):", err);
    }
  }

  // ── Invoice first ──────────────────────────────────────────────────────────

  /**
   * Spend the code BEFORE the invoice exists, and hand it back if the invoice
   * write then fails. The other order would let a discounted invoice exist
   * with nothing in the ledger to explain it.
   */
  let redemptionId: string | null = null;
  if (discountCode) {
    try {
      const redemption = await redeem({
        codeId: discountCode.id,
        code: discountCode.code,
        phone: input.phone,
        customerName: input.name.trim(),
        gross: quote.gross,
        discount: quote.discount?.amount ?? 0,
        net: quote.total,
        channel: "online",
      });
      redemptionId = redemption.id;
    } catch (err) {
      if (err instanceof DiscountError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      console.error("discount redemption failed:", err);
      return NextResponse.json(
        { error: "We couldn't apply that code. Please try again or ask at the counter." },
        { status: 502 }
      );
    }
  }

  try {
    const booking = await billing.createBooking({
      customer: { name: input.name, phone: input.phone, kidNames },
      lines: quote.lines,
      validationCode,
    });

    // Mirror the invoice into our own ledger. Best-effort by contract: the
    // booking lives in the billing backend and must never be lost to a
    // Postgres hiccup — a missed mirror row costs history, not money.
    let mirror: { invoiceId: string; customerId: string } | null = null;
    if (dbConfigured()) {
      mirror = await recordInvoice({
        number: booking.invoiceNumber,
        source: "app",
        customer: {
          phone: input.phone,
          name: input.name,
          kidNames: kidNames.join(", "),
          swipeRef: booking.customerRef ?? null,
        },
        swipeRef: booking.docRef ?? null,
        grossInr: quote.gross,
        discountInr: quote.discount?.amount ?? 0,
        netInr: quote.total,
        lines: quoteMirrorLines(quote.lines),
        metadata: { validation_code: validationCode },
      }).catch((err) => {
        console.error("invoice mirror failed:", err);
        return null;
      });
    }

    // Close the loop on the redemption now that the invoice has a number.
    // Best-effort: the discount is already real (it's in the invoice prices),
    // so a failure here costs a ledger cross-reference, not the booking.
    if (redemptionId) {
      try {
        await attachInvoice(redemptionId, {
          invoiceId: mirror?.invoiceId ?? null,
          invoiceNumber: booking.invoiceNumber,
        });
      } catch (err) {
        console.error("failed to link redemption to invoice:", err);
      }
    }

    // The marketing answer is best-effort: losing it must never lose a booking.
    // First answer wins, and the form only asks genuinely new customers.
    if (input.heardFrom.length && dbConfigured()) {
      try {
        const customerId =
          mirror?.customerId ??
          (await upsertCustomer({ phone: input.phone, name: input.name })).customer.id;
        await setHeardFrom(customerId, [...input.heardFrom]);
      } catch (err) {
        console.error("heard-from save failed:", err);
      }
    }

    await bumpBoard();

    return NextResponse.json({
      pending: false,
      skipPayment: true,
      payment: null,
      invoiceNumber: booking.invoiceNumber,
      ref: booking.ref,
      validationCode,
      total: quote.total,
      gross: quote.gross,
      discount: quote.discount ?? null,
    });
  } catch (err) {
    console.error("checkout failed:", err);
    // The code was spent before the invoice was attempted — give it back, or a
    // single-use code would be burnt by a booking that never got created.
    if (redemptionId) {
      await releaseRedemption(redemptionId).catch((e) =>
        console.error("failed to release redemption after failed booking:", e)
      );
    }
    return NextResponse.json(
      { error: "We couldn't create your booking. Please try again or ask at the counter." },
      { status: 502 }
    );
  }
}
