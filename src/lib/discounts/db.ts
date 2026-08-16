/**
 * Discount-code store — codes and their redemptions.
 *
 * Postgres is the ledger of record here, deliberately. The discount itself also
 * lands on the Swipe invoice (that's what the books and GST run on) and, for
 * online payments, in the Razorpay order notes — but neither of those can
 * answer "has this single-use code been burnt?" without scanning invoices, so
 * the limit checks live here and only here.
 *
 * A redemption is written when the DISCOUNTED INVOICE is created, not when the
 * money arrives. That's the moment the discount is actually granted: if the
 * family then abandons Razorpay, they still owe the reduced amount at the
 * counter, so the code is rightly spent. The only thing that gives it back is
 * cancelling the invoice (the no-show path), which releases the row.
 *
 * Redemptions reference customers and invoices by OUR ids. The customer NAME
 * is still stored alongside (same reason the expense flow stores employee
 * names): the ledger has to stay readable even when there's no customer row —
 * a counter one-off with no phone — or the linked rows change later. The
 * invoice number is mirrored into metadata for the same reason.
 */

import { randomUUID } from "node:crypto";
import { getPool } from "../pg";
import { appEnvironment, ensureSchema, ms, msOrNull, TS } from "../db/schema";
import { upsertCustomer } from "../customers/db";
import {
  DiscountError,
  type DiscountChannel,
  type DiscountCode,
  type DiscountKind,
  type DiscountRedemption,
  type DiscountUsage,
} from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */

const num = (v: any): number => (v == null ? 0 : Number(v));
const maybeNum = (v: any): number | null => (v == null ? null : Number(v));

function toCode(r: any): DiscountCode {
  return {
    id: r.id,
    code: r.code,
    kind: r.kind as DiscountKind,
    value: num(r.value),
    maxDiscount: maybeNum(r.max_discount),
    minOrder: num(r.min_order),
    usage: r.usage as DiscountUsage,
    perCustomerLimit: r.per_customer_limit == null ? null : Number(r.per_customer_limit),
    totalLimit: r.total_limit == null ? null : Number(r.total_limit),
    startsAt: msOrNull(r.starts_at),
    expiresAt: msOrNull(r.expires_at),
    active: r.active,
    channels: String(r.channels)
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean) as DiscountChannel[],
    note: r.note,
    createdByEmployeeId: r.created_by_employee_id ?? null,
    createdByName: r.created_by_name,
    createdAt: ms(r.created_at),
    timesUsed: r.times_used == null ? 0 : Number(r.times_used),
  };
}

function toRedemption(r: any): DiscountRedemption {
  return {
    id: r.id,
    codeId: r.code_id ?? null,
    code: r.code,
    customerId: r.customer_id ?? null,
    phone: r.customer_phone ?? "",
    customerName: r.customer_name,
    invoiceId: r.invoice_id ?? null,
    invoice: r.invoice_number ?? "",
    gross: num(r.gross_inr),
    discount: num(r.discount_inr),
    net: num(r.net_inr),
    channel: r.channel as DiscountChannel,
    status: r.status,
    rzpOrderId: r.rzp_order_id,
    rzpPaymentId: r.rzp_payment_id,
    appliedByEmployeeId: r.applied_by_employee_id ?? null,
    appliedByName: r.applied_by_name,
    reason: r.reason,
    createdAt: ms(r.created_at),
  };
}

/** Live redemptions per code — released ones don't count against a limit. */
const USED_COUNT = `
  SELECT count(*) FROM discount_redemptions r
  WHERE r.code_id = c.id AND r.status <> 'released'
`;

const REDEMPTION_SELECT = `
  SELECT r.*, cu.phone AS customer_phone,
    COALESCE(i.number, r.metadata->>'invoice_number', '') AS invoice_number
  FROM discount_redemptions r
  LEFT JOIN customers cu ON cu.id = r.customer_id
  LEFT JOIN invoices i ON i.id = r.invoice_id
`;

// ── Codes ────────────────────────────────────────────────────────────────────

export async function listCodes(includeInactive = true): Promise<DiscountCode[]> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT c.*, (${USED_COUNT}) AS times_used FROM discount_codes c
     ${includeInactive ? "" : "WHERE c.active"}
     ORDER BY c.active DESC, c.created_at DESC`
  );
  return rows.map(toCode);
}

export async function findCode(code: string): Promise<DiscountCode | null> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT c.*, (${USED_COUNT}) AS times_used FROM discount_codes c
     WHERE upper(c.code) = upper($1)`,
    [code.trim()]
  );
  return rows[0] ? toCode(rows[0]) : null;
}

export interface CreateCodeInput {
  code: string;
  kind: DiscountKind;
  value: number;
  maxDiscount: number | null;
  minOrder: number;
  usage: DiscountUsage;
  /** Only meaningful for usage = per_customer. */
  perCustomerLimit: number | null;
  startsAt: number | null;
  expiresAt: number | null;
  channels: DiscountChannel[];
  note: string;
  createdByEmployeeId: string | null;
  createdByName: string;
}

/** Thrown when the code already exists — the one error worth its own message. */
export class DuplicateCodeError extends Error {
  constructor(readonly code: string) {
    super(`${code} already exists`);
    this.name = "DuplicateCodeError";
  }
}

export async function createCode(input: CreateCodeInput): Promise<DiscountCode> {
  await ensureSchema();
  // The usage mode IS the two limit columns; deriving them here means callers
  // (and the ops form) never have to keep three fields consistent by hand.
  const totalLimit = input.usage === "single" ? 1 : null;
  const perCustomerLimit = input.usage === "per_customer" ? (input.perCustomerLimit ?? 1) : null;

  try {
    const { rows } = await getPool().query(
      `INSERT INTO discount_codes (
         id, code, kind, value, max_discount, min_order, usage,
         per_customer_limit, total_limit, starts_at, expires_at, active,
         channels, note, created_by_employee_id, created_by_name
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,${TS("$10")},${TS("$11")},TRUE,$12,$13,$14,$15)
       RETURNING *, 0 AS times_used`,
      [
        randomUUID(),
        input.code.trim().toUpperCase(),
        input.kind,
        input.value,
        input.maxDiscount,
        input.minOrder,
        input.usage,
        perCustomerLimit,
        totalLimit,
        input.startsAt,
        input.expiresAt,
        input.channels.join(","),
        input.note,
        input.createdByEmployeeId,
        input.createdByName,
      ]
    );
    return toCode(rows[0]);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      throw new DuplicateCodeError(input.code.trim().toUpperCase());
    }
    throw err;
  }
}

/**
 * Codes are switched off, never deleted — a spent code still has redemptions
 * pointing at it, and the ledger has to keep reading correctly.
 */
export async function setCodeActive(id: string, active: boolean): Promise<DiscountCode | null> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `UPDATE discount_codes SET active = $2, last_updated_at = now() WHERE id = $1
     RETURNING *, (SELECT count(*) FROM discount_redemptions r
                   WHERE r.code_id = discount_codes.id AND r.status <> 'released') AS times_used`,
    [id, active]
  );
  return rows[0] ? toCode(rows[0]) : null;
}

// ── Evaluating a code against one booking ────────────────────────────────────

/**
 * ₹ a discount takes off a given gross, honouring its cap. Never exceeds gross.
 * Takes the terms rather than a whole code row, so a one-off counter grant is
 * priced by exactly the same arithmetic as a code.
 */
export function discountAmountFor(
  terms: { kind: DiscountKind; value: number; maxDiscount?: number | null },
  gross: number
): number {
  const raw = terms.kind === "percent" ? (gross * terms.value) / 100 : terms.value;
  const capped = terms.maxDiscount != null ? Math.min(raw, terms.maxDiscount) : raw;
  return Math.round(Math.min(Math.max(capped, 0), gross) * 100) / 100;
}

/**
 * Everything about a code that doesn't need a write: is it usable by this
 * customer, on this channel, for this amount. Throws DiscountError so callers
 * can hand the refusal straight to the UI.
 *
 * This is the read half of redeem() and is intentionally NOT authoritative on
 * its own — two people can pass it at once for the last single-use code. The
 * form calls it to show the discount live; redeem() re-checks under a lock.
 */
export async function evaluateCode(input: {
  code: string;
  phone: string;
  gross: number;
  channel: DiscountChannel;
  at?: number;
}): Promise<{ code: DiscountCode; amount: number }> {
  const found = await findCode(input.code);
  if (!found) throw new DiscountError("not_found");
  const now = input.at ?? Date.now();

  if (!found.active) throw new DiscountError("inactive");
  if (found.startsAt != null && now < found.startsAt) throw new DiscountError("not_started");
  if (found.expiresAt != null && now > found.expiresAt) throw new DiscountError("expired");
  if (!found.channels.includes(input.channel)) throw new DiscountError("wrong_channel");
  if (input.gross < found.minOrder) throw new DiscountError("min_order");
  if (found.totalLimit != null && found.timesUsed >= found.totalLimit) {
    throw new DiscountError("exhausted");
  }
  if (found.perCustomerLimit != null) {
    const used = await countRedemptionsByPhone(found.id, input.phone);
    if (used >= found.perCustomerLimit) throw new DiscountError("customer_limit");
  }

  return { code: found, amount: discountAmountFor(found, input.gross) };
}

/** Redemptions by this phone's customer — a number with no customer row has
 *  redeemed nothing yet. */
async function countRedemptionsByPhone(codeId: string, phone: string): Promise<number> {
  const { rows } = await getPool().query(
    `SELECT count(*)::int AS n FROM discount_redemptions r
     JOIN customers cu ON cu.id = r.customer_id
     WHERE r.code_id = $1 AND cu.phone = $2 AND r.status <> 'released'`,
    [codeId, phone]
  );
  return rows[0]?.n ?? 0;
}

// ── Redeeming ────────────────────────────────────────────────────────────────

export interface RedeemInput {
  /** Null for a one-off counter grant with no code behind it. */
  codeId: string | null;
  /** Display code; "MANUAL" for a one-off grant. */
  code: string;
  /** Empty for a counter one-off where nobody asked the phone number. */
  phone: string;
  customerName: string;
  gross: number;
  discount: number;
  net: number;
  channel: DiscountChannel;
  rzpOrderId?: string;
  appliedByEmployeeId?: string | null;
  appliedByName?: string;
  reason?: string;
}

/**
 * Write the redemption, re-checking the limits under a row lock so two
 * simultaneous bookings can't both spend the last use of a single-use code.
 *
 * The lock is on the code row and the volume here is a few redemptions a day,
 * so serialising them costs nothing and removes the whole class of
 * count-then-insert races that a bare check would leave open.
 */
export async function redeem(
  input: RedeemInput,
  opts?: {
    /**
     * Record without re-checking limits. For the pay-first flow: the code was
     * evaluated when the order was priced, and by the time the money lands the
     * last use may nominally be gone — but the customer has already PAID the
     * discounted amount, so the ledger records what happened rather than
     * arguing with it. Limits stay strict everywhere a price is still fluid.
     */
    skipLimits?: boolean;
  }
): Promise<DiscountRedemption> {
  await ensureSchema();

  // Resolve (or create) the customer before taking the code lock — an upsert
  // has no business inside it.
  let customerId: string | null = null;
  if (/^\d{10}$/.test(input.phone)) {
    const { customer } = await upsertCustomer({
      phone: input.phone,
      name: input.customerName || "Customer",
    });
    customerId = customer.id;
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    // A one-off counter grant has no code row, so there's nothing to lock or
    // limit — it's a manager's decision, recorded rather than policed.
    if (input.codeId && !opts?.skipLimits) {
      const { rows: locked } = await client.query(
        `SELECT * FROM discount_codes WHERE id = $1 FOR UPDATE`,
        [input.codeId]
      );
      if (!locked[0]) throw new DiscountError("not_found");
      const code = toCode(locked[0]);
      if (!code.active) throw new DiscountError("inactive");

      const { rows: counts } = await client.query(
        `SELECT
           count(*)::int AS total,
           count(*) FILTER (WHERE customer_id = $2 AND customer_id IS NOT NULL)::int AS mine
         FROM discount_redemptions
         WHERE code_id = $1 AND status <> 'released'`,
        [input.codeId, customerId]
      );
      const total = counts[0]?.total ?? 0;
      const mine = counts[0]?.mine ?? 0;
      if (code.totalLimit != null && total >= code.totalLimit) {
        throw new DiscountError("exhausted");
      }
      if (code.perCustomerLimit != null && mine >= code.perCustomerLimit) {
        throw new DiscountError("customer_limit");
      }
    }

    const { rows } = await client.query(
      `INSERT INTO discount_redemptions (
         id, code_id, code, customer_id, customer_name, gross_inr, discount_inr,
         net_inr, channel, status, rzp_order_id, applied_by_employee_id,
         applied_by_name, reason
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'applied',$10,$11,$12,$13)
       RETURNING *`,
      [
        randomUUID(),
        input.codeId,
        input.code,
        customerId,
        input.customerName,
        input.gross,
        input.discount,
        input.net,
        input.channel,
        input.rzpOrderId ?? "",
        input.appliedByEmployeeId ?? null,
        input.appliedByName ?? "",
        input.reason ?? "",
      ]
    );
    await client.query("COMMIT");
    return toRedemption({ ...rows[0], customer_phone: input.phone, invoice_number: "" });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Fill in the invoice after the fact. The online flow redeems before it knows
 * the invoice (the code has to be spent before the discounted invoice can be
 * built), so this closes the loop. `invoiceId` may be null when the invoice
 * mirror write failed — the number still lands in metadata so the ledger reads.
 */
export async function attachInvoice(
  redemptionId: string,
  link: { invoiceId: string | null; invoiceNumber: string }
): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `UPDATE discount_redemptions SET
       invoice_id = COALESCE($2, invoice_id),
       metadata = metadata || $3::jsonb,
       last_updated_at = now()
     WHERE id = $1`,
    [redemptionId, link.invoiceId, JSON.stringify({ invoice_number: link.invoiceNumber })]
  );
}

/**
 * Redemptions tied to one invoice number, however the link was recorded.
 * IN, not =: Swipe reissues serials after deletions, so several rows can wear
 * one number; scoped to this environment so a local test serial can't touch a
 * prod redemption. appEnvironment() is a process constant from a fixed set —
 * inlining it keeps the fragment single-parameter for its callers.
 */
const invoiceMatch = (col = "invoice_id", meta = "metadata") => `
  (${col} IN (SELECT id FROM invoices
              WHERE number = $1 AND environment = '${appEnvironment()}')
   OR ${meta}->>'invoice_number' = $1)
`;

/**
 * Tie a discounted booking to the Razorpay payment that settled it, so a
 * redemption can be traced to money in either direction later.
 */
export async function attachPayment(input: {
  invoice: string;
  rzpOrderId?: string;
  rzpPaymentId?: string;
}): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `UPDATE discount_redemptions SET
       rzp_order_id = COALESCE(NULLIF($2, ''), rzp_order_id),
       rzp_payment_id = COALESCE(NULLIF($3, ''), rzp_payment_id),
       last_updated_at = now()
     WHERE ${invoiceMatch()} AND status <> 'released'`,
    [input.invoice, input.rzpOrderId ?? "", input.rzpPaymentId ?? ""]
  );
}

/**
 * Correct the money on a redemption once the provider has re-priced the
 * invoice. The counter flow has to reserve the use before it touches Swipe, and
 * Swipe's own arithmetic (rounding across GST slabs) is the last word on what
 * actually came off — so the ledger takes its figures from the result.
 */
export async function finalizeRedemption(
  id: string,
  totals: {
    invoiceId: string | null;
    invoiceNumber: string;
    gross: number;
    discount: number;
    net: number;
  }
): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `UPDATE discount_redemptions SET
       invoice_id = COALESCE($2, invoice_id),
       metadata = metadata || $3::jsonb,
       gross_inr = $4, discount_inr = $5, net_inr = $6,
       last_updated_at = now()
     WHERE id = $1`,
    [
      id, totals.invoiceId, JSON.stringify({ invoice_number: totals.invoiceNumber }),
      totals.gross, totals.discount, totals.net,
    ]
  );
}

/**
 * Same, addressed by the gateway order — what the browser confirm flow has to
 * hand (the invoice number is behind an opaque provider ref there).
 */
export async function attachPaymentByOrder(
  rzpOrderId: string,
  rzpPaymentId: string
): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `UPDATE discount_redemptions SET rzp_payment_id = $2, last_updated_at = now()
     WHERE rzp_order_id = $1 AND status <> 'released'`,
    [rzpOrderId, rzpPaymentId]
  );
}

/**
 * Give the code back when the booking it was spent on never happened. Used on
 * the failure paths: the code is redeemed before the discounted invoice is
 * written (so the ledger can never miss a discount), which means a failed
 * invoice write has to hand the use back.
 */
export async function releaseRedemption(id: string): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `UPDATE discount_redemptions SET status = 'released', last_updated_at = now() WHERE id = $1`,
    [id]
  );
}

/**
 * Give the code back when the invoice it discounted is cancelled (the no-show
 * path). Idempotent, and safe to call for invoices that had no discount.
 */
export async function releaseForInvoice(invoice: string): Promise<number> {
  await ensureSchema();
  const { rowCount } = await getPool().query(
    `UPDATE discount_redemptions SET status = 'released', last_updated_at = now()
     WHERE ${invoiceMatch()} AND status <> 'released'`,
    [invoice]
  );
  return rowCount ?? 0;
}

export async function listRedemptions(opts?: {
  codeId?: string;
  limit?: number;
}): Promise<DiscountRedemption[]> {
  await ensureSchema();
  const params: unknown[] = [];
  let where = "";
  if (opts?.codeId) {
    params.push(opts.codeId);
    where = `WHERE r.code_id = $${params.length}`;
  }
  params.push(opts?.limit ?? 200);
  const { rows } = await getPool().query(
    `${REDEMPTION_SELECT} ${where}
     ORDER BY r.created_at DESC LIMIT $${params.length}`,
    params
  );
  return rows.map(toRedemption);
}

/** The discount already on one invoice, if any — null when it was clean. */
export async function findByInvoice(invoice: string): Promise<DiscountRedemption | null> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `${REDEMPTION_SELECT}
     WHERE ${invoiceMatch("r.invoice_id", "r.metadata")}
       AND r.status <> 'released'
     ORDER BY r.created_at DESC LIMIT 1`,
    [invoice]
  );
  return rows[0] ? toRedemption(rows[0]) : null;
}

/* eslint-enable @typescript-eslint/no-explicit-any */
