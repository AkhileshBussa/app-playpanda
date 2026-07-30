import { NextResponse } from "next/server";
import { z } from "zod";
import { billing } from "@/lib/billing";
import { fetchTestPayment, testGatewayEnabled, verifyTestSignature } from "@/lib/testGateway";

const verifySchema = z.object({
  ref: z.string().min(1),
  orderId: z.string().min(1),
  paymentId: z.string().min(1),
  signature: z.string().min(1),
  raw: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Called by the browser after Razorpay checkout succeeds. The billing backend
 * verifies the gateway signature and marks the invoice paid — no gateway keys
 * live on our side, so a forged signature simply fails verification there.
 */
export async function POST(req: Request) {
  let input: z.infer<typeof verifySchema>;
  try {
    input = verifySchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    if (testGatewayEnabled()) {
      // Test-mode payment: the order was created directly on Razorpay (not by
      // Swipe), so verify the signature locally and record the payment on the
      // invoice counter-style. pay_success_v2 only knows live Swipe orders.
      if (!verifyTestSignature(input.orderId, input.paymentId, input.signature)) {
        return NextResponse.json({ error: "Payment verification failed" }, { status: 400 });
      }
      const paid = await fetchTestPayment(input.paymentId);
      await billing.recordPayment({
        ref: input.ref,
        amount: paid.amountInr,
        method: paid.method,
        transactionRef: input.paymentId,
      });
    } else {
      await billing.confirmOnlinePayment(input);
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
