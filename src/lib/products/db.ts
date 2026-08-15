/**
 * Product store — our own catalogue rows, so invoices, memberships and
 * reporting all reference OUR product ids. swipe_ref (the Swipe product id,
 * the same value pricing.ts calls `sku`) is the only Swipe-specific handle,
 * and the natural key rows are upserted against.
 *
 * Rows appear lazily: the first invoice or membership that uses a product
 * writes it here from the code catalogue. There's no sync job to run or
 * forget — the table always covers exactly what's actually been sold.
 */

import { randomUUID } from "node:crypto";
import { getPool } from "../pg";
import { ensureSchema } from "../db/schema";

export type ProductKind = "play" | "addon" | "membership_plan" | "membership_punch" | "other";

export interface EnsureProductInput {
  /** Swipe product id (pricing.ts `sku` / plans.ts product ids, as a string). */
  swipeRef: string;
  name: string;
  kind: ProductKind;
  itemType: "Product" | "Service";
  /** Tax-inclusive list price, INR. Null for priced-per-plan punch products. */
  priceInr: number | null;
  taxRatePercent: number;
}

/** Upsert by swipe_ref and return our product id. */
export async function ensureProduct(input: EnsureProductInput): Promise<string> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `INSERT INTO products (id, name, kind, item_type, price_inr, tax_rate_percent, swipe_ref)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (swipe_ref) DO UPDATE SET
       name = EXCLUDED.name,
       kind = EXCLUDED.kind,
       item_type = EXCLUDED.item_type,
       price_inr = COALESCE(EXCLUDED.price_inr, products.price_inr),
       tax_rate_percent = EXCLUDED.tax_rate_percent,
       last_updated_at = now()
     RETURNING id`,
    [
      randomUUID(), input.name, input.kind, input.itemType,
      input.priceInr, input.taxRatePercent, input.swipeRef,
    ]
  );
  return rows[0].id as string;
}
