import { NextResponse } from "next/server";
import { z } from "zod";
import { applyDiscount, computeQuote, PACKAGES, type PackageId, type Quote } from "@/lib/pricing";
import { billing, type PaymentOrder } from "@/lib/billing";
import { createPaymentOrder, gatewayEnabled } from "@/lib/razorpay";
import { HEARD_FROM_SOURCES } from "@/lib/heardFrom";
import { setHeardFrom, upsertCustomer } from "@/lib/customers/db";
import { mergeInvoiceMetadata, quoteMirrorLines, recordInvoice } from "@/lib/invoices/db";
import { dbConfigured } from "@/lib/pg";
import {
  attachInvoice,
  attachPayment,
  evaluateCode,
  redeem,
  releaseRedemption,
} from "@/lib/discounts/db";
import { DiscountError } from "@/lib/discounts/types";
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

  /**
   * Spend the code BEFORE the invoice exists, and hand it back if the invoice
   * write then fails. The other order would let a discounted invoice exist with
   * nothing in the ledger to explain it, and an unexplained discount in the
   * books is worse than a code that has to be given back.
   *
   * The customer's payment choice deliberately doesn't matter here: a family
   * holding a code gets it whether they pay online or at the counter, so the
   * invoice is created discounted either way.
   */
  let redemptionId: string | null = null;
  if (input.discountCode) {
    // The form hides the box when codes are off; this is the half that matters,
    // since a hidden field is no protection against a hand-made request.
    if (!CUSTOMER_CODES_ENABLED) {
      return NextResponse.json({ error: "That code isn't valid" }, { status: 400 });
    }
    if (!dbConfigured()) {
      return NextResponse.json({ error: "That code isn't valid" }, { status: 400 });
    }
    try {
      const { code, amount } = await evaluateCode({
        code: input.discountCode,
        phone: input.phone,
        gross: quote.total,
        channel: "online",
      });
      const discounted = applyDiscount(quote, { code: code.code, amount });
      const redemption = await redeem({
        codeId: code.id,
        code: code.code,
        phone: input.phone,
        customerName: input.name.trim(),
        gross: discounted.gross,
        discount: discounted.discount?.amount ?? 0,
        net: discounted.total,
        channel: "online",
      });
      redemptionId = redemption.id;
      quote = discounted;
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

  // 4-digit code the customer shows and the counter matches against the invoice.
  const validationCode = String(Math.floor(1000 + Math.random() * 9000));
  const paymentsEnabled = process.env.NEXT_PUBLIC_PAYMENTS_ENABLED !== "false";

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

    // The invoice now exists in the billing backend (unpaid). With payments
    // on, also create a Razorpay order (our own account — see lib/razorpay)
    // so the browser can open checkout. Any failure here degrades to
    // pay-at-counter — the booking is already saved and must never be lost
    // to a payment hiccup.
    let payment: PaymentOrder | null = null;
    if (paymentsEnabled && input.payNow !== false && gatewayEnabled()) {
      try {
        // The code rides along in the order notes so a discounted booking can
        // be recognised from the Razorpay dashboard alone, without joining
        // anything — the mapping the counter asked for, on the gateway side.
        payment = await createPaymentOrder(quote.total, booking.invoiceNumber, quote.discount);
      } catch (err) {
        console.error("payment order creation failed (falling back to counter):", err);
      }
    }

    // Remember which order was created for this invoice — the verify path
    // finds the mirror row by order id, since it only holds gateway handles.
    if (payment && mirror) {
      await mergeInvoiceMetadata(mirror.invoiceId, { rzp_order_id: payment.orderId }).catch(
        (err) => console.error("failed to note razorpay order on invoice:", err)
      );
    }

    // Remember which order settled this discount, once we know its id.
    if (redemptionId && payment) {
      try {
        await attachPayment({ invoice: booking.invoiceNumber, rzpOrderId: payment.orderId });
      } catch (err) {
        console.error("failed to link redemption to razorpay order:", err);
      }
    }

    return NextResponse.json({
      skipPayment: payment == null,
      payment,
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
