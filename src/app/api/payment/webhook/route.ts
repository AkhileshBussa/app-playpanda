import { NextResponse } from "next/server";
import { billing } from "@/lib/billing";
import {
  claimPaymentRecord,
  methodLabel,
  releasePaymentRecord,
  verifyWebhookSignature,
} from "@/lib/razorpay";

export const dynamic = "force-dynamic";

/**
 * Razorpay webhook — the safety net for the confirm flow. If the customer's
 * browser dies between paying and /api/payment/verify, this still marks the
 * invoice paid. Configure on the Razorpay dashboard with events
 * `payment.captured` and `order.paid`, secret = RAZORPAY_WEBHOOK_SECRET.
 *
 * The order's `receipt` carries the invoice number (set at order creation),
 * so the payment is recorded via collectPayment — addressed by invoice
 * number, and refusing anything over the outstanding balance, which backstops
 * the Redis claim against double-recording.
 *
 * Response codes matter: Razorpay retries non-2xx deliveries, so transient
 * failures return 500 (with the claim released) and permanent ones return 200
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
  // payment.captured carries only the payment; order.paid also carries the
  // order (with our receipt). notes.invoice is the fallback for the former.
  const invoiceNumber = String(
    event?.payload?.order?.entity?.receipt ?? payment?.notes?.invoice ?? ""
  );
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const paymentId = String(payment?.id ?? "");
  const amountInr = Number(payment?.amount ?? 0) / 100;
  if (!paymentId || !invoiceNumber || !(amountInr > 0)) {
    // Not one of our orders (no receipt) or malformed — nothing to retry.
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
