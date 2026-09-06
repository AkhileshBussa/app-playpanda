/**
 * Swipe PRODUCTS — the stock catalogue.
 *
 * Swipe already maintains inventory properly: quantities are live, every sale
 * decrements them, and every purchase invoice puts them back. So this reads
 * that rather than keeping a second count here — the same rule expenses and
 * purchases follow. A stock number in two places is a stock number that
 * disagrees with itself by Friday.
 *
 * What the app adds is a way to SEE it: what's on hand, what it cost, what
 * it's worth, and what has run down far enough to reorder.
 *
 * Caveat carried from earlier probing: v3/products/get does not return service
 * items or the ₹0 membership punch products, and it caps out around 76 rows.
 * That's precisely right here — those aren't stock — but it means this must
 * never be treated as "the whole catalogue".
 */

import { swipeRequest } from "../billing/swipe";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface StockProduct {
  /** Swipe product id — the handle every other call takes. */
  id: number;
  name: string;
  category: string;
  unit: string;
  /** Units on hand right now. */
  qty: number;
  /** Tax-inclusive selling price, INR. */
  priceWithTax: number;
  taxRatePercent: number;
  /** What a unit cost us, INR. 0 when nobody has ever recorded one. */
  costPrice: number;
  /** Reorder level. 0 means none set — not "reorder immediately". */
  lowStockAt: number;
  /** qty × cost — what the shelf is worth at what we paid. */
  stockValueInr: number;
  /** Per-unit margin, or null when the cost isn't trustworthy enough to say. */
  marginInr: number | null;
  /**
   * Why a margin couldn't be shown, for the UI to explain rather than just
   * printing a dash:
   *  - "no-cost"    nobody has recorded what it cost
   *  - "cost-above" cost is at or above the selling price, which for a
   *                 playzone tuck shop means the cost field is wrong, not that
   *                 we're selling at a loss on purpose
   */
  marginIssue: "no-cost" | "cost-above" | null;
  /** True when on hand has fallen to the reorder level (and one is set). */
  isLow: boolean;
}

/**
 * The cost we'll believe for a product.
 *
 * Swipe carries both purchase_price and avg_purchase_price, and in this
 * account they disagree in ways that matter: "Socks Adults Size - 4" has an
 * average of ₹69, which is its SELLING price, not what it cost. Prefer the
 * explicit purchase price and fall back to the average, then let the caller
 * flag anything that still looks wrong rather than quietly reporting a margin
 * built on a bad number.
 */
function costOf(r: any): number {
  const explicit = Number(r.purchase_price ?? 0);
  if (explicit > 0) return explicit;
  return Number(r.avg_purchase_price ?? 0);
}

function toProduct(r: any): StockProduct {
  const qty = Number(r.qty ?? r.final_qty ?? 0);
  const cost = costOf(r);
  // The list endpoint returns price ex-tax; price_with_tax is what a customer
  // actually hands over, and the only figure worth comparing a cost against.
  const priceWithTax = Number(r.price_with_tax ?? r.price ?? 0);
  const lowStockAt = Number(r.low_stock ?? 0);

  let marginIssue: StockProduct["marginIssue"] = null;
  if (cost <= 0) marginIssue = "no-cost";
  else if (cost >= priceWithTax && priceWithTax > 0) marginIssue = "cost-above";

  return {
    id: Number(r.id ?? r.product_id),
    name: String(r.product_name ?? "").trim(),
    category: String(r.product_category ?? "").trim(),
    unit: String(r.unit ?? "").trim(),
    qty,
    priceWithTax,
    taxRatePercent: Number(r.tax ?? 0),
    costPrice: cost,
    lowStockAt,
    stockValueInr: qty * cost,
    marginInr: marginIssue ? null : priceWithTax - cost,
    marginIssue,
    isLow: lowStockAt > 0 && qty <= lowStockAt,
  };
}

/**
 * Kitchen categories, which are billed but never stocked in.
 *
 * Swipe decrements a product on every sale, so a dish that is made to order
 * from ingredients drifts further negative with each one sold: at the time of
 * writing 60 of the 86 rows in these two categories are below zero, dragging
 * the catalogue's total "stock value" to about minus fifty thousand rupees.
 * They are a menu, not an inventory, and counting units of Baby Corn
 * Manchurian tells nobody anything.
 *
 * A deny-list rather than an allow-list on purpose: a genuinely new retail
 * line should appear on the stock page by itself, and a new kitchen category
 * that slips through announces itself soon enough by going negative.
 */
const NOT_STOCK_CATEGORIES = new Set(["Restaurant", "Raghavendra"]);

/** Retail stock only — the things bought as units and sold as units. */
export async function listStockProducts(): Promise<StockProduct[]> {
  const body = await swipeRequest<{ products?: any[] }>("v3/products", "get", {
    num_records: 250,
    page: 0,
    search: "",
    search_type: "Product",
    category: "All",
    sorter: "",
    sort_type: "product_name",
    is_low_stock: false,
    user_ids: [],
    selected_categories: [],
    hide_zero_qty: false,
    product_type_filter: "",
  });

  return (body.products ?? [])
    // Services (play sessions, memberships) have no stock to speak of.
    .filter((r) => String(r.product_type ?? "") === "Product")
    .filter((r) => !NOT_STOCK_CATEGORIES.has(String(r.product_category ?? "").trim()))
    .map(toProduct)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** One product's full record — the shape an edit has to round-trip. */
export async function getProductDetails(productId: number): Promise<Record<string, unknown> | null> {
  const body = await swipeRequest<{ product_details?: any[] }>("product", "get_details", {
    product_id: productId,
  });
  return body.product_details?.[0] ?? null;
}

/* eslint-enable @typescript-eslint/no-explicit-any */
