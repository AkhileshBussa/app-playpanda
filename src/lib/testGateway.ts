/**
 * DEV/TEST-ONLY Razorpay harness — rehearse the full payment flow with
 * Razorpay TEST MODE (no real money) even though the live flow runs through
 * Swipe's connected account.
 *
 * Why this exists: Swipe's doc_rzp_create_order always uses the LIVE connected
 * Razorpay account; the dashboard's Test Mode toggle only applies to keys you
 * generate yourself. So while RAZORPAY_TEST_KEY_ID/SECRET (rzp_test_...) are
 * set, /api/checkout creates the order directly on Razorpay in test mode, and
 * /api/payment/verify checks the signature locally and records the payment on
 * the Swipe invoice counter-style (billing.recordPayment). Swipe's
 * pay_success_v2 is live-only and stays untouched — the final proof of that
 * path still needs one real payment.
 *
 * The booking/invoice side is NOT faked: test bookings still create real Swipe
 * invoices (visible on the counter screen) and need cleanup afterwards.
 *
 * Guard rails: refuses any key that isn't rzp_test_..., so this can never move
 * real money. Clear both env vars (and restart) to restore the live flow.
 * Never set these on Vercel.
 */

import { createHmac, timingSafeEqual } from "crypto";
import type { PaymentOrder } from "./billing";

const RZP_API = "https://api.razorpay.com/v1";

function testKeys(): { keyId: string; secret: string } | null {
  const keyId = process.env.RAZORPAY_TEST_KEY_ID ?? "";
  const secret = process.env.RAZORPAY_TEST_KEY_SECRET ?? "";
  // Hard guard: test-mode keys only — a live key here would charge real money
  // outside the Swipe flow.
  if (!keyId.startsWith("rzp_test_") || !secret) return null;
  return { keyId, secret };
}

export function testGatewayEnabled(): boolean {
  return testKeys() != null;
}

function authHeader(keys: { keyId: string; secret: string }): string {
  return `Basic ${Buffer.from(`${keys.keyId}:${keys.secret}`).toString("base64")}`;
}

/** Create a test-mode order directly on Razorpay (bypasses Swipe). */
export async function createTestOrder(
  amountInr: number,
  invoiceNumber: string
): Promise<PaymentOrder> {
  const keys = testKeys();
  if (!keys) throw new Error("Test gateway not configured");

  const res = await fetch(`${RZP_API}/orders`, {
    method: "POST",
    headers: { Authorization: authHeader(keys), "Content-Type": "application/json" },
    body: JSON.stringify({
      amount: Math.round(amountInr * 100),
      currency: "INR",
      receipt: invoiceNumber,
      payment_capture: 1,
      notes: { source: "playpanda-test-harness" },
    }),
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as {
    id?: string;
    amount?: number;
    currency?: string;
    error?: { description?: string };
  };
  if (!res.ok || !body.id) {
    throw new Error(`Razorpay test order failed: ${body.error?.description ?? res.status}`);
  }
  return {
    orderId: body.id,
    keyId: keys.keyId,
    amountMinor: Number(body.amount ?? Math.round(amountInr * 100)),
    currency: String(body.currency ?? "INR"),
  };
}

/** Standard Razorpay checkout signature check: HMAC-SHA256("order|payment"). */
export function verifyTestSignature(
  orderId: string,
  paymentId: string,
  signature: string
): boolean {
  const keys = testKeys();
  if (!keys) return false;
  const expected = createHmac("sha256", keys.secret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

const METHOD_LABELS: Record<string, string> = {
  upi: "UPI",
  card: "Card",
  netbanking: "Net Banking",
  wallet: "Wallet",
};

/** Payment details for recording on the invoice (amount in INR). */
export async function fetchTestPayment(
  paymentId: string
): Promise<{ amountInr: number; method: string }> {
  const keys = testKeys();
  if (!keys) throw new Error("Test gateway not configured");

  const res = await fetch(`${RZP_API}/payments/${paymentId}`, {
    headers: { Authorization: authHeader(keys) },
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as {
    amount?: number;
    method?: string;
    error?: { description?: string };
  };
  if (!res.ok) {
    throw new Error(`Razorpay payment fetch failed: ${body.error?.description ?? res.status}`);
  }
  return {
    amountInr: Number(body.amount ?? 0) / 100,
    method: METHOD_LABELS[String(body.method)] ?? "Other",
  };
}
