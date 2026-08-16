import { NextResponse } from "next/server";
import { billing } from "@/lib/billing";
import {
  claimPaymentRecord,
  methodLabel,
  releasePaymentRecord,
  verifyWebhookSignature,
} from "@/lib/razorpay";
import { dbConfigured } from "@/lib/pg";
import { attachPayment, attachPaymentByOrder } from "@/lib/discounts/db";
import { recordPaymentMirror } from "@/lib/invoices/db";
import { fulfilPendingBooking } from "@/lib/bookings/pending";

export const dynamic = "force-dynamic";

/**
 * Razorpay webhook — the safety net for the confirm flow. If the customer's
 * browser dies between paying and /api/payment/verify, this still turns the
 * money into a booking. Configure on the Razorpay dashboard with events
 * `payment.captured` and `order.paid`, secret = RAZORPAY_WEBHOOK_SECRET.
 *
 * Pay-first orders are fulfilled from their pending booking (looked up by
 * ORDER id — the receipt is just a placeholder for these). Legacy orders
 * carry the invoice number in the order receipt / payment notes and are
 * recorded via collectPayment as before.
 *
 * Response codes matter: Razorpay retries non-2xx deliveries, so transient
 * failures return 500 (with any claim released) and permanent ones return 200
 * so a bad event isn't redelivered forever.
 */
export async function POST(req: Request) {
  // Signature is over the RAW body — read it before any JSON parsing.
  const rawBody = await req.text();
  const signature = req.headers.get("x-razorpay-signature") ?? "";
  if (!verifyWebhookSignature(rawBody, signature)) {
    return NextResponse.json({ error: "Bad signature" }, { status: 401 });
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Bad payload" }, { status: 400 });
  }

  if (event?.event !== "payment.captured" && event?.event !== "order.paid") {
    return NextResponse.json({ ok: true, ignored: event?.event ?? "unknown" });
  }

  const payment = event?.payload?.payment?.entity;
  const orderId = String(event?.payload?.order?.entity?.id ?? payment?.order_id ?? "");
  // payment.captured carries only the payment; order.paid also carries the
  // order (with our receipt). notes.invoice is the fallback for the former.
  const invoiceNumber = String(
    event?.payload?.order?.entity?.receipt ?? payment?.notes?.invoice ?? ""
  );
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const paymentId = String(payment?.id ?? "");
  const amountInr = Number(payment?.amount ?? 0) / 100;
  if (!paymentId || !(amountInr > 0)) {
    return NextResponse.json({ ok: true, ignored: "no payment in event" });
  }

  // ── Pay-first orders: build the booking from its pending row ──────────────
  if (dbConfigured() && orderId) {
    try {
      const fulfil = await fulfilPendingBooking({
        rzpOrderId: orderId,
        rzpPaymentId: paymentId,
        amountInr,
        method: methodLabel(payment?.method),
      });
      if (fulfil.ok) {
        await attachPaymentByOrder(orderId, paymentId).catch((err) =>
          console.error("failed to link webhook payment to redemption:", err)
        );
        return NextResponse.json({
          ok: true,
          invoiceNumber: fulfil.invoiceNumber,
          alreadyRecorded: fulfil.alreadyDone,
        });
      }
      // Not a pending order — fall through to the legacy invoice path.
    } catch (err) {
      // The claim was reverted inside fulfil; a 500 makes Razorpay redeliver,
      // which is exactly the retry loop we want while Swipe is down.
      console.error(`webhook fulfilment for order ${orderId} failed (will retry):`, err);
      return NextResponse.json({ error: "Temporary failure" }, { status: 500 });
    }
  }

  // ── Legacy invoice-first orders ────────────────────────────────────────────
  if (!invoiceNumber || invoiceNumber.startsWith("PENDING-")) {
    // A pay-first receipt with no pending row (or no reference at all) —
    // nothing to record against; don't let Razorpay retry forever.
    return NextResponse.json({ ok: true, ignored: "no invoice reference" });
  }

  if (!(await claimPaymentRecord(paymentId))) {
    return NextResponse.json({ ok: true, alreadyRecorded: true });
  }

  try {
    const result = await billing.collectPayment({
      invoiceNumber,
      amount: amountInr,
      method: methodLabel(payment?.method),
      transactionRef: paymentId,
    });
    // Ledger mirror + redemption cross-reference. Never allowed to affect the
    // response: Razorpay would retry a recorded payment.
    if (dbConfigured()) {
      await recordPaymentMirror({
        invoiceNumber,
        amountInr,
        method: methodLabel(payment?.method),
        transactionRef: paymentId,
        rzpOrderId: orderId,
        rzpPaymentId: paymentId,
        amountDueAfter: result.amountDue,
      }).catch((err) => console.error("webhook payment mirror failed:", err));
      await attachPayment({ invoice: invoiceNumber, rzpPaymentId: paymentId }).catch((err) =>
        console.error("failed to link webhook payment to redemption:", err)
      );
    }
    return NextResponse.json({ ok: true, invoiceNumber, amountDue: result.amountDue });
  } catch (err) {
    // Unknown invoice, already-settled, or over-collection are permanent:
    // swallow with a log so Razorpay stops retrying. (Already-settled is the
    // normal case when the browser confirm recorded first and Redis was down.)
    // Anything else (Swipe down) gets a retry.
    await releasePaymentRecord(paymentId);
    const message = err instanceof Error ? err.message : String(err);
    if (/no invoice .* found|already settled|is due on/i.test(message)) {
      console.error(`webhook payment ${paymentId} not recorded (permanent): ${message}`);
      return NextResponse.json({ ok: true, ignored: message });
    }
    console.error(`webhook payment ${paymentId} record failed (will retry):`, err);
    return NextResponse.json({ error: "Temporary failure" }, { status: 500 });
  }
}
