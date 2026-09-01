/**
 * Invoice mirror — every invoice the app creates lands here too, with its
 * lines and payments, so the business finally has its own ledger: visit
 * history per customer, product-level sales, repeat rates. Swipe remains the
 * books of record for GST; this table is ours.
 *
 * Mirror writes are BEST-EFFORT BY CONTRACT: callers must never fail a
 * booking or a payment because Postgres hiccuped. Everything here throws
 * normally; call sites wrap with .catch(console.error). The one exception is
 * reads the discount ledger depends on (invoice ids for redemptions) — those
 * callers decide their own failure story.
 *
 * The session lifecycle stamps (check-in/out/removal) are written against
 * swipe_ref, because the ops board's session ids ARE the provider doc handle
 * (suffixed #i when one invoice splits into several cards — the suffix is
 * stripped, all cards of an invoice share the row).
 */

import { randomUUID } from "node:crypto";
import { getPool } from "../pg";
import { appEnvironment, ensureSchema } from "../db/schema";
import { upsertCustomer, type UpsertCustomerInput } from "../customers/db";
import { ensureProduct, type ProductKind } from "../products/db";

export type InvoiceSource = "app" | "counter" | "membership_punch" | "external";
export type InvoiceStatus = "unpaid" | "part_paid" | "paid" | "cancelled";

export interface MirrorLine {
  /** Swipe product id (pricing.ts sku). Maps to products.swipe_ref. */
  sku: string;
  name: string;
  kind: ProductKind;
  itemType: "Product" | "Service";
  quantity: number;
  /** Tax-inclusive unit price actually billed (net of any discount). */
  unitPriceInr: number;
  taxRatePercent: number;
  totalInr: number;
  /** Catalogue list price for the product row; defaults to unitPriceInr. */
  listPriceInr?: number | null;
}

export interface RecordInvoiceInput {
  number: string;
  source: InvoiceSource;
  customer: UpsertCustomerInput;
  /** Swipe document hash id (Booking.docRef); null when the provider didn't say. */
  swipeRef: string | null;
  grossInr: number;
  discountInr: number;
  netInr: number;
  lines: MirrorLine[];
  metadata?: Record<string, unknown>;
}

/**
 * Write one invoice with its customer, products and lines. Idempotent on the
 * provider doc hash (swipe_ref): replaying a request that already landed
 * returns the existing row untouched. NOT on the number — Swipe reissues a
 * serial after the document holding it is deleted, so two different invoices
 * can legitimately carry the same number over time.
 */
export async function recordInvoice(
  input: RecordInvoiceInput
): Promise<{ invoiceId: string; customerId: string }> {
  await ensureSchema();
  const { customer } = await upsertCustomer(input.customer);

  // Product upserts commute (keyed on swipe_ref), so they sit outside the
  // transaction; the invoice + items go in atomically.
  const productIds = new Map<string, string>();
  for (const line of input.lines) {
    if (productIds.has(line.sku)) continue;
    productIds.set(
      line.sku,
      await ensureProduct({
        swipeRef: line.sku,
        name: line.name,
        kind: line.kind,
        itemType: line.itemType,
        priceInr: line.listPriceInr === undefined ? line.unitPriceInr : line.listPriceInr,
        taxRatePercent: line.taxRatePercent,
      })
    );
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO invoices (
         id, number, customer_id, source, status, gross_inr, discount_inr,
         net_inr, environment, swipe_ref, metadata
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (swipe_ref) WHERE swipe_ref IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        randomUUID(), input.number, customer.id, input.source,
        input.netInr <= 0 ? "paid" : "unpaid",
        input.grossInr, input.discountInr, input.netInr,
        appEnvironment(), input.swipeRef, JSON.stringify(input.metadata ?? {}),
      ]
    );

    const invoiceId = rows[0]?.id as string | undefined;
    if (!invoiceId) {
      // Already mirrored (a replay of the same provider doc) — leave the
      // existing row and lines alone.
      const existing = await client.query(`SELECT id FROM invoices WHERE swipe_ref = $1`, [
        input.swipeRef,
      ]);
      await client.query("COMMIT");
      return { invoiceId: existing.rows[0].id, customerId: customer.id };
    }

    for (const line of input.lines) {
      await client.query(
        `INSERT INTO invoice_items (
           id, invoice_id, product_id, name, quantity, unit_price_inr,
           tax_rate_percent, total_inr
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          randomUUID(), invoiceId, productIds.get(line.sku) ?? null, line.name,
          line.quantity, line.unitPriceInr, line.taxRatePercent, line.totalInr,
        ]
      );
    }
    await client.query("COMMIT");
    return { invoiceId, customerId: customer.id };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** A minimal row for an invoice we didn't create (e.g. a membership sale
 *  billed by hand in Swipe) — enough for other tables to reference. */
export async function ensureExternalInvoice(input: {
  number: string;
  customer: UpsertCustomerInput;
  totalInr: number | null;
  issuedAt?: number | null;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  await ensureSchema();
  const { customer } = await upsertCustomer(input.customer);
  // Numbers aren't unique over time (see recordInvoice), so this is a plain
  // find-else-create. The flow is a manager linking one sale — no write race.
  const existing = await findInvoiceIdByNumber(input.number);
  if (existing) return existing;
  const { rows } = await getPool().query(
    `INSERT INTO invoices (
       id, number, customer_id, source, gross_inr, net_inr, issued_at, environment, metadata
     ) VALUES ($1,$2,$3,'external',$4,$4,COALESCE(to_timestamp($5::double precision / 1000.0), now()),$6,$7)
     RETURNING id`,
    [
      randomUUID(), input.number, customer.id, input.totalInr ?? 0,
      input.issuedAt ?? null, appEnvironment(), JSON.stringify(input.metadata ?? {}),
    ]
  );
  return rows[0].id as string;
}

/** The row a human means by that number today: this environment's newest
 *  live one (a cancelled row only matches when no live row carries the
 *  number, and another environment's rows never match at all). */
export async function findInvoiceIdByNumber(number: string): Promise<string | null> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT id FROM invoices WHERE number = $1 AND environment = $2
     ORDER BY (status = 'cancelled')::int, issued_at DESC LIMIT 1`,
    [number, appEnvironment()]
  );
  return rows[0]?.id ?? null;
}

/** Merge keys into the invoice's metadata (e.g. the gateway order id). */
export async function mergeInvoiceMetadata(
  invoiceId: string,
  patch: Record<string, unknown>
): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `UPDATE invoices SET metadata = metadata || $2::jsonb, last_updated_at = now()
     WHERE id = $1`,
    [invoiceId, JSON.stringify(patch)]
  );
}

export interface RecordPaymentMirrorInput {
  /** One of the two must be set. */
  invoiceId?: string;
  invoiceNumber?: string;
  /** Find the invoice via metadata.rzp_order_id (the browser-confirm path,
   *  which only holds gateway ids). Used when neither id nor number is known. */
  rzpOrderId?: string;
  amountInr: number;
  method: string;
  transactionRef?: string;
  rzpPaymentId?: string;
  /** What the provider says is still owed, when the caller knows it. */
  amountDueAfter?: number | null;
}

/**
 * Mirror one payment and roll the invoice's paid total/status forward.
 * Returns false when the invoice isn't mirrored (pre-ledger or hand-made in
 * Swipe) — nothing to attach to, and that's fine.
 */
export async function recordPaymentMirror(input: RecordPaymentMirrorInput): Promise<boolean> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    let invoiceId = input.invoiceId ?? null;
    if (!invoiceId && input.invoiceNumber) {
      // Serial reuse: a payment addressed by number belongs to THIS
      // environment's newest live invoice wearing it — never a cancelled
      // predecessor, never another environment's test row.
      const r = await client.query(
        `SELECT id FROM invoices WHERE number = $1 AND environment = $2
         ORDER BY (status = 'cancelled')::int, issued_at DESC LIMIT 1`,
        [input.invoiceNumber, appEnvironment()]
      );
      invoiceId = r.rows[0]?.id ?? null;
    }
    if (!invoiceId && input.rzpOrderId) {
      const r = await client.query(`SELECT id FROM invoices WHERE metadata->>'rzp_order_id' = $1`, [
        input.rzpOrderId,
      ]);
      invoiceId = r.rows[0]?.id ?? null;
    }
    if (!invoiceId) {
      await client.query("ROLLBACK");
      return false;
    }

    // The partial unique index on rzp_payment_id makes gateway payments
    // idempotent across the verify/webhook race; counter payments have no
    // gateway id and are deduplicated upstream by the collect flow.
    const inserted = await client.query(
      `INSERT INTO payments (
         id, invoice_id, amount_inr, method, transaction_ref, rzp_order_id, rzp_payment_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        randomUUID(), invoiceId, input.amountInr, input.method,
        input.transactionRef ?? "", input.rzpOrderId ?? "", input.rzpPaymentId ?? "",
      ]
    );

    if (inserted.rows[0]) {
      await client.query(
        `UPDATE invoices SET
           amount_paid_inr = amount_paid_inr + $2,
           status = CASE
             WHEN status = 'cancelled' THEN 'cancelled'
             WHEN $3::numeric IS NOT NULL AND $3::numeric <= 0 THEN 'paid'
             WHEN $3::numeric IS NOT NULL THEN 'part_paid'
             WHEN amount_paid_inr + $2 >= net_inr THEN 'paid'
             ELSE 'part_paid'
           END,
           last_updated_at = now()
         WHERE id = $1`,
        [invoiceId, input.amountInr, input.amountDueAfter ?? null]
      );
    }
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Re-price the mirror after a counter discount rewrote the invoice. Items are
 * scaled by the same net/gross ratio the re-pricing used, so line totals keep
 * summing to the header.
 */
export async function applyDiscountMirror(
  invoiceId: string,
  totals: { grossInr: number; discountInr: number; netInr: number }
): Promise<void> {
  await ensureSchema();
  const ratio = totals.grossInr > 0 ? totals.netInr / totals.grossInr : 1;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE invoices SET gross_inr = $2, discount_inr = $3, net_inr = $4,
         last_updated_at = now()
       WHERE id = $1`,
      [invoiceId, totals.grossInr, totals.discountInr, totals.netInr]
    );
    await client.query(
      `UPDATE invoice_items SET
         unit_price_inr = round(unit_price_inr * $2::numeric, 2),
         total_inr = round(total_inr * $2::numeric, 2),
         last_updated_at = now()
       WHERE invoice_id = $1`,
      [invoiceId, ratio]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export interface EditInvoiceMirrorInput {
  /** The provider doc handle behind the card (the unsuffixed ops session id). */
  swipeRef: string;
  /** Who the booking now belongs to — a phone change repoints the invoice. */
  customer: UpsertCustomerInput;
  /** New invoice total, ₹. Edits are refused on discounted invoices, so after
   *  one the gross and the net are the same catalogue-priced figure. */
  totalInr: number;
  /** The full new line set — an edit is a whole replacement, in Swipe and here. */
  lines: MirrorLine[];
}

/**
 * Re-shape the mirror after a counter edit rewrote the booking: the customer,
 * the totals, and the lines, replaced wholesale. Payments stay put and the
 * status is recomputed from what's been paid against the new total — an
 * upgrade on a paid booking correctly drops it back to part_paid. Returns
 * false when the invoice was never mirrored (pre-ledger); nothing to update.
 */
export async function editInvoiceMirror(input: EditInvoiceMirrorInput): Promise<boolean> {
  await ensureSchema();
  const { customer } = await upsertCustomer(input.customer);

  const productIds = new Map<string, string>();
  for (const line of input.lines) {
    if (productIds.has(line.sku)) continue;
    productIds.set(
      line.sku,
      await ensureProduct({
        swipeRef: line.sku,
        name: line.name,
        kind: line.kind,
        itemType: line.itemType,
        priceInr: line.listPriceInr === undefined ? line.unitPriceInr : line.listPriceInr,
        taxRatePercent: line.taxRatePercent,
      })
    );
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `UPDATE invoices SET
         customer_id = $2,
         gross_inr = $3,
         discount_inr = 0,
         net_inr = $3,
         status = CASE
           WHEN status = 'cancelled' THEN 'cancelled'
           WHEN $3::numeric <= 0 OR amount_paid_inr >= $3::numeric THEN 'paid'
           WHEN amount_paid_inr > 0 THEN 'part_paid'
           ELSE 'unpaid'
         END,
         last_updated_at = now()
       WHERE swipe_ref = $1
       RETURNING id`,
      [input.swipeRef, customer.id, input.totalInr]
    );
    const invoiceId = rows[0]?.id as string | undefined;
    if (!invoiceId) {
      await client.query("ROLLBACK");
      return false;
    }

    await client.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [invoiceId]);
    for (const line of input.lines) {
      await client.query(
        `INSERT INTO invoice_items (
           id, invoice_id, product_id, name, quantity, unit_price_inr,
           tax_rate_percent, total_inr
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          randomUUID(), invoiceId, productIds.get(line.sku) ?? null, line.name,
          line.quantity, line.unitPriceInr, line.taxRatePercent, line.totalInr,
        ]
      );
    }
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** The no-show path: the Swipe document is deleted, the mirror row is kept
 *  and marked — history survives cancellation. */
export async function markInvoiceCancelled(number: string): Promise<string | null> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `UPDATE invoices SET status = 'cancelled', cancelled_at = now(), last_updated_at = now()
     WHERE id = (
       SELECT id FROM invoices
       WHERE number = $1 AND environment = $2 AND status <> 'cancelled'
       ORDER BY issued_at DESC LIMIT 1
     )
     RETURNING id`,
    [number, appEnvironment()]
  );
  return rows[0]?.id ?? null;
}

// ── Session lifecycle stamps ─────────────────────────────────────────────────

const STAMP_COLUMNS = {
  checkin: "checkin_at",
  checkout: "checkout_at",
  removed: "removed_at",
} as const;

/**
 * Stamp (or clear, at = null) a session event on the invoice behind a board
 * card. No-op for invoices that aren't mirrored. `sessionId` is the ops board
 * id — the provider doc handle, possibly #i-suffixed.
 */
export async function stampInvoiceSession(
  kind: keyof typeof STAMP_COLUMNS,
  sessionId: string,
  at: number | null
): Promise<void> {
  await ensureSchema();
  const column = STAMP_COLUMNS[kind];
  const swipeRef = sessionId.split("#")[0];
  await getPool().query(
    `UPDATE invoices SET ${column} = ${at == null ? "NULL" : "to_timestamp($2::double precision / 1000.0)"},
       last_updated_at = now()
     WHERE swipe_ref = $1`,
    at == null ? [swipeRef] : [swipeRef, at]
  );
}

// ── Quote mapping ────────────────────────────────────────────────────────────

import { EXTRA_ADULT, PACKAGES, SOCKS, type QuoteLine } from "../pricing";

const PLAY_SKUS = new Set<string>(PACKAGES.map((p) => p.sku));
/** Catalogue list prices by sku — product rows keep the list price even when
 *  the line being mirrored was discounted. */
const LIST_PRICES = new Map<string, number>([
  ...PACKAGES.map((p) => [p.sku, p.pricePerKid] as [string, number]),
  [EXTRA_ADULT.sku, EXTRA_ADULT.price],
  [SOCKS.child.sku, SOCKS.child.price],
  [SOCKS.adult.sku, SOCKS.adult.price],
]);

/** Booking-quote lines → mirror lines (same shapes the invoice carries). */
export function quoteMirrorLines(lines: QuoteLine[]): MirrorLine[] {
  return lines.map((l) => ({
    sku: l.sku,
    name: l.name,
    kind: PLAY_SKUS.has(l.sku) ? "play" : "addon",
    itemType: l.itemType,
    quantity: l.quantity,
    unitPriceInr: l.priceWithTax,
    taxRatePercent: l.taxRatePercent,
    totalInr: l.lineTotal,
    listPriceInr: LIST_PRICES.get(l.sku) ?? null,
  }));
}
