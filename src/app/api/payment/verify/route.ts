import { NextResponse } from "next/server";
import { z } from "zod";
import { billing } from "@/lib/billing";
import {
  claimPaymentRecord,
  fetchPayment,
  releasePaymentRecord,
  verifyCheckoutSignature,
} from "@/lib/razorpay";

const verifySchema = z.object({
  ref: z.string().min(1),
  orderId: z.string().min(1),
  paymentId: z.string().min(1),
  signature: z.string().min(1),
  raw: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Called by the browser after Razorpay checkout succeeds. The signature is
 * verified here with our key secret, then the payment is re-fetched from
 * Razorpay — the authority on amount and capture — before being recorded on
 * the invoice. The webhook (/api/payment/webhook) covers the same payment if
 * this call never arrives; the Redis claim keeps the two from double-recording.
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
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("online payment verification failed:", err);
    // The gateway said the payment went through; only our confirm call failed.
    // Never show a scary failure — the counter can reconcile from the payment
    // confirmation on the customer's phone.
    return NextResponse.json(
      {
        error:
          "Payment received, but we couldn't update the invoice. Please show your payment confirmation at the counter.",
      },
      { status: 502 }
    );
  }
}
