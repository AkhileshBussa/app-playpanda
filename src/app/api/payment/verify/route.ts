import { NextResponse } from "next/server";
import { z } from "zod";
import { billing } from "@/lib/billing";
import {
  claimPaymentRecord,
  fetchPayment,
  releasePaymentRecord,
  verifyCheckoutSignature,
} from "@/lib/razorpay";
import { dbConfigured } from "@/lib/pg";
import { attachPaymentByOrder } from "@/lib/discounts/db";
import { recordPaymentMirror } from "@/lib/invoices/db";
import { bumpBoard } from "@/lib/ops/state";
import { fulfilPendingBooking } from "@/lib/bookings/pending";

const verifySchema = z.object({
  /** Legacy invoice-first bookings only; pay-first bookings have no ref yet. */
  ref: z.string().min(1).optional(),
  orderId: z.string().min(1),
  paymentId: z.string().min(1),
  signature: z.string().min(1),
  raw: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Called by the browser after Razorpay checkout succeeds. The signature is
 * verified with our key secret, then the payment is re-fetched from Razorpay
 * — the authority on amount and capture — before anything is written.
 *
 * Pay-first bookings (the normal case): the pending booking is fulfilled here
 * — Swipe invoice created, payment recorded, ledger mirrored — and the
 * invoice number goes back to the browser for the confirmation screen. The
 * webhook covers the same payment if this call never arrives; the pending
 * row's claim keeps the two from double-building.
 *
 * Legacy orders (created by the invoice-first flow before this deploy) still
 * carry a `ref` and are recorded against their existing invoice as before.
 */
export async function POST(req: Request) {
  let input: z.infer<typeof verifySchema>;
  try {
    input = verifySchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  if (!verifyCheckoutSignature(input.orderId, input.paymentId, input.signature)) {
    return NextResponse.json({ error: "Payment verification failed" }, { status: 400 });
  }

  try {
    const paid = await fetchPayment(input.paymentId);
    // The signature proves the ids belong together; the fetch proves the money
    // actually moved (captured) and how much, independent of anything the
    // browser claims.
    if (!paid.captured || paid.orderId !== input.orderId) {
      return NextResponse.json({ error: "Payment not captured" }, { status: 400 });
    }

    // Pay-first: build the booking now that the money is confirmed.
    if (dbConfigured()) {
      const fulfil = await fulfilPendingBooking({
        rzpOrderId: input.orderId,
        rzpPaymentId: input.paymentId,
        amountInr: paid.amountInr,
        method: paid.method,
      });
      if (fulfil.ok) {
        await attachPaymentByOrder(input.orderId, input.paymentId).catch((err) =>
          console.error("failed to link payment to redemption:", err)
        );
        return NextResponse.json({ ok: true, invoiceNumber: fulfil.invoiceNumber });
      }
      // fall through: not a pending order — a legacy invoice-first booking.
    }

    if (!input.ref) {
      // A pay-first order but the booking couldn't be looked up — the webhook
      // (with Razorpay's retries) is the safety net.
      throw new Error(`no pending booking and no ref for order ${input.orderId}`);
    }

    if (await claimPaymentRecord(input.paymentId)) {
      try {
        await billing.recordPayment({
          ref: input.ref,
          amount: paid.amountInr,
          method: paid.method,
          transactionRef: input.paymentId,
        });
      } catch (err) {
        // Give the claim back so the webhook (or a retry) can still record it.
        await releasePaymentRecord(input.paymentId);
        throw err;
      }
    }

    // Ledger mirror + discount cross-reference. Best-effort by design: the
    // money is in, and neither is worth failing a payment confirmation over.
    if (dbConfigured()) {
      await recordPaymentMirror({
        rzpOrderId: input.orderId,
        amountInr: paid.amountInr,
        method: paid.method,
        transactionRef: input.paymentId,
        rzpPaymentId: input.paymentId,
      }).catch((err) => console.error("online payment mirror failed:", err));
      await attachPaymentByOrder(input.orderId, input.paymentId).catch((err) =>
        console.error("failed to link payment to redemption:", err)
      );
    }
    await bumpBoard();
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("online payment verification failed:", err);
    // The gateway said the payment went through; only our side failed. The
    // webhook will retry the fulfilment — never show a scary failure, the
    // counter can reconcile from the payment confirmation on the phone.
    return NextResponse.json(
      {
        error:
          "Payment received, but we couldn't finish the booking just now. Please show your payment confirmation at the counter.",
      },
      { status: 502 }
    );
  }
}
