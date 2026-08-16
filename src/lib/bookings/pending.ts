/**
 * Pay-first online bookings.
 *
 * The online flow creates NOTHING in Swipe until Razorpay confirms the money:
 * a failed or abandoned payment must leave no invoice behind. So /api/checkout
 * parks the priced booking here (keyed by the gateway order), and whichever
 * confirmation path arrives first — the browser verify or the webhook —
 * claims the row and builds the real thing: Swipe invoice, Swipe payment,
 * ledger mirror, discount redemption, heard-from answer.
 *
 * The claim is the pending row's status flip (pending → consumed), done as a
 * single conditional UPDATE — the loser of the race simply finds no row to
 * claim. If fulfilment fails AFTER the claim (Swipe down), the claim is
 * reverted so the webhook's retry delivery can run it again: the customer has
 * paid, so the invoice must eventually exist.
 *
 * Pay-at-counter bookings never come through here — an unpaid invoice is the
 * whole point of that flow, so it's still created up front.
 */

import { randomUUID } from "node:crypto";
import { dbConfigured, getPool } from "../pg";
import { appEnvironment, ensureSchema } from "../db/schema";
import { billing } from "../billing";
import type { QuoteLine } from "../pricing";
import { quoteMirrorLines, recordInvoice, recordPaymentMirror } from "../invoices/db";
import { setHeardFrom } from "../customers/db";
import { attachInvoice, redeem } from "../discounts/db";

/** Everything needed to build the invoice once the money is in. */
export interface PendingBookingPayload {
  customer: { name: string; phone: string; kidNames: string[] };
  lines: QuoteLine[];
  grossInr: number;
  discountInr: number;
  netInr: number;
  validationCode: string;
  /** Code details when one was applied — redeemed at fulfilment. */
  discount: {
    codeId: string | null;
    code: string;
  } | null;
  heardFrom: string[];
}

export function pendingConfigured(): boolean {
  return dbConfigured();
}

export async function createPendingBooking(
  rzpOrderId: string,
  payload: PendingBookingPayload
): Promise<string> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `INSERT INTO pending_bookings (id, rzp_order_id, payload, environment)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [randomUUID(), rzpOrderId, JSON.stringify(payload), appEnvironment()]
  );
  return rows[0].id as string;
}

interface PendingRow {
  id: string;
  payload: PendingBookingPayload;
  invoiceNumber: string | null;
}

/** The pending row for an order, claimed or not — null means this order isn't
 *  a pay-first booking (e.g. one created by the older invoice-first flow). */
export async function findPendingByOrder(rzpOrderId: string): Promise<PendingRow | null> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT id, payload, metadata->>'invoice_number' AS invoice_number
     FROM pending_bookings WHERE rzp_order_id = $1`,
    [rzpOrderId]
  );
  if (!rows[0]) return null;
  return {
    id: rows[0].id,
    payload: rows[0].payload as PendingBookingPayload,
    invoiceNumber: rows[0].invoice_number ?? null,
  };
}

/** One-shot claim; false when another path already took (or finished) it. */
async function claimPending(id: string): Promise<boolean> {
  const { rows } = await getPool().query(
    `UPDATE pending_bookings SET status = 'consumed', last_updated_at = now()
     WHERE id = $1 AND status = 'pending' RETURNING id`,
    [id]
  );
  return Boolean(rows[0]);
}

async function revertClaim(id: string): Promise<void> {
  await getPool().query(
    `UPDATE pending_bookings SET status = 'pending', last_updated_at = now()
     WHERE id = $1 AND status = 'consumed'`,
    [id]
  );
}

async function noteInvoice(id: string, invoiceNumber: string): Promise<void> {
  await getPool().query(
    `UPDATE pending_bookings SET metadata = metadata || $2::jsonb, last_updated_at = now()
     WHERE id = $1`,
    [id, JSON.stringify({ invoice_number: invoiceNumber })]
  );
}

export interface FulfilInput {
  rzpOrderId: string;
  rzpPaymentId: string;
  amountInr: number;
  method: string;
}

export type FulfilResult =
  | { ok: true; invoiceNumber: string; alreadyDone: boolean }
  | { ok: false; notPending: true };

/**
 * Turn a paid pending booking into the real invoice. Idempotent across the
 * verify/webhook race; throws when Swipe fails so the webhook path can retry
 * (the claim is reverted first).
 */
export async function fulfilPendingBooking(input: FulfilInput): Promise<FulfilResult> {
  const pending = await findPendingByOrder(input.rzpOrderId);
  if (!pending) return { ok: false, notPending: true };

  if (!(await claimPending(pending.id))) {
    // The other delivery path got here first. Its invoice number may still be
    // in flight; report what we know.
    return { ok: true, invoiceNumber: pending.invoiceNumber ?? "", alreadyDone: true };
  }

  const p = pending.payload;
  try {
    const booking = await billing.createBooking({
      customer: p.customer,
      lines: p.lines.map((l) => ({
        sku: l.sku,
        name: l.name,
        itemType: l.itemType,
        quantity: l.quantity,
        taxRatePercent: l.taxRatePercent,
        priceWithTax: l.priceWithTax,
      })),
      validationCode: p.validationCode,
    });

    await billing.recordPayment({
      ref: booking.ref,
      amount: input.amountInr,
      method: input.method,
      transactionRef: input.rzpPaymentId,
    });

    await noteInvoice(pending.id, booking.invoiceNumber).catch(() => {});

    // Ledger writes — best-effort as everywhere: the paid Swipe invoice is
    // already real, and none of these may take the confirmation down.
    const mirror = await recordInvoice({
      number: booking.invoiceNumber,
      source: "app",
      customer: {
        phone: p.customer.phone,
        name: p.customer.name,
        kidNames: p.customer.kidNames.join(", "),
        swipeRef: booking.customerRef ?? null,
      },
      swipeRef: booking.docRef ?? null,
      grossInr: p.grossInr,
      discountInr: p.discountInr,
      netInr: p.netInr,
      lines: quoteMirrorLines(p.lines),
      metadata: { validation_code: p.validationCode, rzp_order_id: input.rzpOrderId },
    }).catch((err) => {
      console.error("pay-first invoice mirror failed:", err);
      return null;
    });

    await recordPaymentMirror({
      invoiceId: mirror?.invoiceId,
      invoiceNumber: booking.invoiceNumber,
      amountInr: input.amountInr,
      method: input.method,
      transactionRef: input.rzpPaymentId,
      rzpOrderId: input.rzpOrderId,
      rzpPaymentId: input.rzpPaymentId,
      amountDueAfter: 0,
    }).catch((err) => console.error("pay-first payment mirror failed:", err));

    // The discount was priced into the order; now that its invoice exists,
    // put the redemption in the ledger. skipLimits: the money already moved.
    if (p.discount) {
      try {
        const redemption = await redeem(
          {
            codeId: p.discount.codeId,
            code: p.discount.code,
            phone: p.customer.phone,
            customerName: p.customer.name,
            gross: p.grossInr,
            discount: p.discountInr,
            net: p.netInr,
            channel: "online",
            rzpOrderId: input.rzpOrderId,
          },
          { skipLimits: true }
        );
        await attachInvoice(redemption.id, {
          invoiceId: mirror?.invoiceId ?? null,
          invoiceNumber: booking.invoiceNumber,
        });
      } catch (err) {
        console.error("pay-first redemption record failed:", err);
      }
    }

    if (p.heardFrom.length && mirror) {
      await setHeardFrom(mirror.customerId, p.heardFrom).catch((err) =>
        console.error("pay-first heard-from save failed:", err)
      );
    }

    return { ok: true, invoiceNumber: booking.invoiceNumber, alreadyDone: false };
  } catch (err) {
    // Money in, invoice not built — hand the claim back so the next delivery
    // (webhook retry) can try again. The customer sees "show your payment
    // confirmation at the counter" in the meantime.
    await revertClaim(pending.id).catch((revertErr) =>
      console.error("CRITICAL: failed to revert pending claim:", pending.id, revertErr)
    );
    throw err;
  }
}
