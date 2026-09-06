/**
 * Who changed a product, and to what.
 *
 * Products live in Swipe, which keeps no history of its own and offers no way
 * to ask who touched what. That was tolerable while only the owner could edit
 * them. Now that the counter can, the record has to exist somewhere, so it
 * lives here — append-only, exactly like the cash ledger's audit trail, and
 * for the same reason: a price that can change without a trace is a price
 * nobody can account for.
 *
 * This does NOT duplicate the product. It stores what changed, which is
 * something Swipe genuinely doesn't hold.
 */

import { randomUUID } from "node:crypto";
import { getPool } from "../pg";
import { appEnvironment, ensureSchema, ms } from "../db/schema";
import type { ProductInput } from "./products";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ProductChange {
  id: string;
  at: number;
  action: "created" | "updated";
  by: string;
  tier: "counter" | "owner";
  /** Plain-English description, e.g. "Costs us ₹20 → ₹22". */
  summary: string;
}

/** The fields worth keeping a history of — the ones a person sets. */
export interface ProductSnapshot {
  name: string;
  priceWithTax: number;
  taxRatePercent: number;
  unit: string;
  category: string;
  costPrice: number;
  lowStockAt: number;
}

export function snapshotOf(input: ProductInput): ProductSnapshot {
  return {
    name: input.name,
    priceWithTax: input.priceWithTax,
    taxRatePercent: input.taxRatePercent,
    unit: input.unit,
    category: input.category ?? "",
    costPrice: input.costPrice ?? 0,
    lowStockAt: input.lowStockAt ?? 0,
  };
}

/** Swipe's product record → the same shape, so before/after compare cleanly. */
export function snapshotOfSwipe(r: Record<string, any>): ProductSnapshot {
  return {
    name: String(r.product_name ?? ""),
    priceWithTax: Number(r.price ?? 0),
    taxRatePercent: Number(r.tax ?? 0),
    unit: String(r.unit ?? ""),
    category: String(r.product_category ?? ""),
    costPrice: Number(r.purchase_price ?? 0),
    lowStockAt: Number(r.low_stock ?? 0),
  };
}

const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

/** Only the fields that actually moved, phrased the way the form labels them. */
function describe(before: ProductSnapshot | null, after: ProductSnapshot): string {
  if (!before) {
    return `Added at ${inr(after.priceWithTax)}${
      after.costPrice > 0 ? `, costing ${inr(after.costPrice)}` : ""
    }`;
  }
  const parts: string[] = [];
  if (before.name !== after.name) parts.push(`Renamed from “${before.name}”`);
  if (before.priceWithTax !== after.priceWithTax) {
    parts.push(`Sells for ${inr(before.priceWithTax)} → ${inr(after.priceWithTax)}`);
  }
  if (before.costPrice !== after.costPrice) {
    parts.push(`Costs us ${inr(before.costPrice)} → ${inr(after.costPrice)}`);
  }
  if (before.taxRatePercent !== after.taxRatePercent) {
    parts.push(`GST ${before.taxRatePercent}% → ${after.taxRatePercent}%`);
  }
  if (before.lowStockAt !== after.lowStockAt) {
    parts.push(`Reorder at ${before.lowStockAt || "none"} → ${after.lowStockAt || "none"}`);
  }
  if (before.unit !== after.unit) parts.push(`Unit ${before.unit || "—"} → ${after.unit || "—"}`);
  if (before.category !== after.category) {
    parts.push(`Category ${before.category || "none"} → ${after.category || "none"}`);
  }
  return parts.length ? parts.join(" · ") : "Saved with no change";
}

/** True when anything a person set actually moved. */
export function changed(before: ProductSnapshot | null, after: ProductSnapshot): boolean {
  if (!before) return true;
  return (Object.keys(after) as Array<keyof ProductSnapshot>).some((k) => before[k] !== after[k]);
}

export async function recordProductChange(input: {
  swipeProductId: number | string;
  productName: string;
  action: "created" | "updated";
  before: ProductSnapshot | null;
  after: ProductSnapshot;
  by: string;
  tier: "counter" | "owner";
}): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `INSERT INTO product_audit
       (id, environment, swipe_ref, product_name, action, before, after, changed_by, changed_tier)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      randomUUID(),
      appEnvironment(),
      String(input.swipeProductId),
      input.productName,
      input.action,
      input.before ? JSON.stringify(input.before) : null,
      JSON.stringify(input.after),
      input.by,
      input.tier,
    ]
  );
}

/** One product's change history, newest first. */
export async function listProductChanges(swipeProductId: number): Promise<ProductChange[]> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT * FROM product_audit WHERE swipe_ref = $1 AND environment = $2
     ORDER BY created_at DESC LIMIT 50`,
    [String(swipeProductId), appEnvironment()]
  );
  return rows.map((r: any) => ({
    id: r.id,
    at: ms(r.created_at),
    action: r.action === "created" ? "created" : "updated",
    by: r.changed_by ?? "",
    tier: r.changed_tier === "owner" ? "owner" : "counter",
    summary: describe(r.before ?? null, r.after),
  }));
}

/* eslint-enable @typescript-eslint/no-explicit-any */
