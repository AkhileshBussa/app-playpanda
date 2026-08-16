/**
 * Razorpay gateway — OUR OWN account, not Swipe's connected one.
 *
 * Architecture switched 2026-08-12 (Akhilesh's call, replacing the
 * Swipe-native doc_rzp_create_order/pay_success_v2 flow): orders are created
 * with our keys, the checkout signature is verified HERE with our key secret,
 * and the payment is then recorded on the Swipe invoice counter-style — the
 * same recordPayment/collectPayment path the counter already uses. Nothing
 * about payment validity depends on Swipe behaviour we can't see, and because
 * the account is ours, Razorpay webhooks (/api/payment/webhook) catch the
 * payment even when the customer's browser dies before confirming.
 *
 * Env:
 *   RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET — rzp_live_ in production.
 *     rzp_test_ keys run the identical flow against Razorpay test mode (no
 *     real money) for local rehearsal, but are REFUSED on a production
 *     deployment so a stray test key can't quietly hand out free play time.
 *   RAZORPAY_WEBHOOK_SECRET — the secret set on the Razorpay dashboard
 *     webhook; only /api/payment/webhook uses it.
 */

import { createHmac, timingSafeEqual } from "crypto";
import type { PaymentOrder } from "./billing";
import { redisCommand } from "./ops/state";

const RZP_API = "https://api.razorpay.com/v1";

function keys(): { keyId: string; secret: string } | null {
  const keyId = process.env.RAZORPAY_KEY_ID ?? "";
  const secret = process.env.RAZORPAY_KEY_SECRET ?? "";
  if (!keyId || !secret) return null;
  // Test keys never belong on the live site: checkout would "succeed" with
  // Razorpay's test instruments and mark real invoices paid.
  if (process.env.VERCEL_ENV === "production" && !keyId.startsWith("rzp_live_")) {
    console.error("Razorpay: refusing non-live key on a production deployment");
    return null;
  }
  return { keyId, secret };
}

/** False ⇒ checkout degrades to pay-at-counter (bookings still work). */
export function gatewayEnabled(): boolean {
  return keys() != null;
}

function authHeader(k: { keyId: string; secret: string }): string {
  return `Basic ${Buffer.from(`${k.keyId}:${k.secret}`).toString("base64")}`;
}

/** Create an order on our Razorpay account. `receipt` carries the invoice
 *  number so the webhook can find its way back to the Swipe invoice.
 *
 *  Razorpay's own Offers feature is deliberately unused: its discounts key off
 *  the payment instrument (this bank's netbanking, that card BIN), not off a
 *  code the customer types, and it can't touch a pay-at-counter booking at all.
 *  Our codes are priced before the order is created, so the gateway only ever
 *  sees the net — the code itself rides along in the notes for reference. */
export async function createPaymentOrder(
  amountInr: number,
  invoiceNumber: string,
  discount?: { code: string; amount: number } | null
): Promise<PaymentOrder> {
  const k = keys();
  if (!k) throw new Error("Razorpay not configured");

  const res = await fetch(`${RZP_API}/orders`, {
    method: "POST",
    headers: { Authorization: authHeader(k), "Content-Type": "application/json" },
    body: JSON.stringify({
      amount: Math.round(amountInr * 100),
      currency: "INR",
      receipt: invoiceNumber,
      payment_capture: 1,
      notes: {
        source: "playpanda-booking",
        invoice: invoiceNumber,
        // Razorpay notes are strings; only present when a code was used.
        ...(discount
          ? { discount_code: discount.code, discount_amount: String(discount.amount) }
          : {}),
      },
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
    throw new Error(`Razorpay order failed: ${body.error?.description ?? res.status}`);
  }
  return {
    orderId: body.id,
    keyId: k.keyId,
    amountMinor: Number(body.amount ?? Math.round(amountInr * 100)),
    currency: String(body.currency ?? "INR"),
  };
}

/** Standard Razorpay checkout signature: HMAC-SHA256("order|payment"). */
export function verifyCheckoutSignature(
  orderId: string,
  paymentId: string,
  signature: string
): boolean {
  const k = keys();
  if (!k) return false;
  const expected = createHmac("sha256", k.secret).update(`${orderId}|${paymentId}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Webhook body signature: HMAC-SHA256 of the RAW request body. */
export function verifyWebhookSignature(rawBody: string, signature: string): boolean {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET ?? "";
  if (!secret || !signature) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
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

/** Swipe's payment-mode label for a Razorpay method string. */
export function methodLabel(method: unknown): string {
  return METHOD_LABELS[String(method)] ?? "Other";
}

export interface GatewayPayment {
  amountInr: number;
  method: string;
  orderId: string;
  /** Money is only final once captured — record nothing before this. */
  captured: boolean;
}

/** The payment as Razorpay knows it — the authority on amount and capture. */
export async function fetchPayment(paymentId: string): Promise<GatewayPayment> {
  const k = keys();
  if (!k) throw new Error("Razorpay not configured");

  const res = await fetch(`${RZP_API}/payments/${paymentId}`, {
    headers: { Authorization: authHeader(k) },
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as {
    amount?: number;
    method?: string;
    order_id?: string;
    status?: string;
    captured?: boolean;
    error?: { description?: string };
  };
  if (!res.ok) {
    throw new Error(`Razorpay payment fetch failed: ${body.error?.description ?? res.status}`);
  }
  return {
    amountInr: Number(body.amount ?? 0) / 100,
    method: methodLabel(body.method),
    orderId: String(body.order_id ?? ""),
    captured: body.captured === true || body.status === "captured",
  };
}

/**
 * One-writer claim on a payment id, so the browser confirm and the webhook
 * can't both record the same payment. Returns true when this caller should
 * record; false when someone already has (treat as success). Release on a
 * failed record so a retry isn't locked out. If Redis itself is down, records
 * anyway — a rare double entry is visible in Swipe; a dropped one isn't.
 */
export async function claimPaymentRecord(paymentId: string): Promise<boolean> {
  try {
    const reply = await redisCommand<string | null>([
      "SET",
      `rzp:recorded:${paymentId}`,
      "1",
      "NX",
      "EX",
      60 * 60 * 24 * 7,
    ]);
    return reply === "OK";
  } catch (err) {
    console.warn("payment claim skipped (redis unavailable):", err);
    return true;
  }
}

export async function releasePaymentRecord(paymentId: string): Promise<void> {
  try {
    await redisCommand(["DEL", `rzp:recorded:${paymentId}`]);
  } catch {
    // claim will expire on its own
  }
}
