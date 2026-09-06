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

import { swipeMultipart, swipeRequest } from "../billing/swipe";
import { changed, recordProductChange, snapshotOf, snapshotOfSwipe } from "./history";

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

/** One movement of stock, in or out, and the document behind it. */
export interface StockMovement {
  /** Swipe's display date, e.g. "05 Sep 2026". */
  date: string;
  direction: "in" | "out";
  qty: number;
  /** Stock remaining after this movement, as Swipe computed it. */
  balance: number;
  /** "invoice" for a sale, "purchase" for a delivery. */
  documentType: string;
  /** INV-2265, PINV-15 — the document this movement belongs to. */
  serialNumber: string;
  /** Who it went to, or who it came from. */
  party: string;
  /** Unit price on that document. */
  priceInr: number;
}

/**
 * Everything that has moved a product's count, newest first.
 *
 * Straight from Swipe's own inventory timeline — the same data its product
 * page shows — so every line maps to a real document rather than to something
 * this app inferred. That matters: it's what turns "we have 136 socks" into
 * "and here is every sale and delivery that got us there".
 */
export async function listStockMovements(
  productId: number,
  limit = 40
): Promise<StockMovement[]> {
  const today = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date());
  // A year back is plenty to see how a line has moved without paging.
  const [d, m, y] = today.split("/");
  const from = `${d}-${m}-${Number(y) - 1}`;

  const body = await swipeRequest<{ transactions?: any[] }>("inventory", "timeline", {
    num_records: limit,
    page: 0,
    payment_status: 0,
    search: "",
    search_type: "Customer",
    date: `${from} - ${d}-${m}-${y}`,
    product_id: productId,
    variant_id: 0,
    batch_id: 0,
    warehouse_id: -1,
    project_id: [],
  });

  return (body.transactions ?? []).map((t) => ({
    date: String(t.transaction_date ?? ""),
    direction: String(t.stock_option ?? "") === "in" ? "in" : "out",
    qty: Number(t.qty ?? 0),
    balance: Number(t.net_qty ?? 0),
    documentType: String(t.document_type ?? ""),
    serialNumber: String(t.serial_number ?? ""),
    party: String(t.name ?? "").trim(),
    priceInr: Number(t.price ?? 0),
  }));
}

/** One product's full record — the shape an edit has to round-trip. */
export async function getProductDetails(productId: number): Promise<Record<string, unknown> | null> {
  const body = await swipeRequest<{ product_details?: any[] }>("product", "get_details", {
    product_id: productId,
  });
  return body.product_details?.[0] ?? null;
}

// ── Writing ──────────────────────────────────────────────────────────────────

/**
 * Creating and editing products.
 *
 * Both go through multipart form posts that Swipe's own product form uses —
 * `product/add` to create, `product/update` to edit — and both take the SAME
 * wide field set. Neither is documented and neither appears in Swipe's web
 * bundle under a name you could guess; the shapes below were taken from the
 * real requests and verified live (product 207: low_stock 0 → 5, cost 0 → 6,
 * with every other field left untouched).
 *
 * Two things learnt the hard way, both worth not re-discovering:
 *
 *  - `product/add` is CREATE ONLY. Posting an edit to it, id and all, is
 *    rejected with "Product with this name already exists" — it never looks at
 *    the id. Editing must go to `product/update`.
 *  - An edit is a FULL REPLACEMENT: whatever the form doesn't send is lost.
 *    So updateProduct reads the product back first and overlays the caller's
 *    changes on the real record, rather than assembling one from defaults.
 *    That's why opening stock, the price-with-tax flag and the custom columns
 *    are round-tripped rather than hardcoded — getting any of them wrong would
 *    silently rewrite a product nobody meant to touch.
 *
 * (There is also a v3/products/update, found by guessing endpoint names. It
 * takes a `products` array, rejects most fields as unknown, appears nowhere in
 * the web bundle, and is presumably for bulk edit. Not used.)
 */

/** What a caller may set. Anything absent keeps the product's current value. */
export interface ProductInput {
  name: string;
  /** Tax-inclusive selling price, INR. */
  priceWithTax: number;
  taxRatePercent: number;
  unit: string;
  category?: string;
  /** What a unit costs us, INR. */
  costPrice?: number;
  /** Reorder level; 0 for none. */
  lowStockAt?: number;
  hsnCode?: string;
}

/** The custom-column ids this account defines, all blank for a stock item. */
const BLANK_CUSTOM_FIELDS = encodeURIComponent(JSON.stringify({ "12": "", "13": "", "15": "" }));

const bool = (v: unknown) => (v ? "true" : "false");
const num = (v: unknown) => String(Number(v ?? 0));

/**
 * The form Swipe's product editor posts. `existing` is the current record for
 * an edit (so untouched fields survive) and undefined for a create.
 */
function productForm(
  input: ProductInput,
  existing?: Record<string, any> | null
): Record<string, string> {
  const id = existing ? String(existing.product_id ?? existing.id ?? "") : "";
  // Preserve how THIS product quotes its price. Forcing tax-inclusive would
  // silently re-price every product that quotes ex-tax.
  const priceWithTax = existing ? Boolean(existing.is_price_with_tax) : true;

  return {
    company_id: "",
    description: String(existing?.description ?? "<p><br></p>"),
    hsn_code: String(input.hsnCode ?? existing?.hsn_code ?? ""),
    id,
    key: "",
    price: String(input.priceWithTax),
    discount_amount: num(existing?.discount_amount),
    is_price_with_tax: bool(priceWithTax),
    product_category: String(input.category ?? existing?.product_category ?? ""),
    product_name: input.name,
    product_type: String(existing?.product_type ?? "Product"),
    tax: String(input.taxRatePercent),
    barcode_id: String(existing?.barcode_id ?? ""),
    avg_purchase_price: "",
    purchase_price: num(input.costPrice ?? existing?.purchase_price),
    purchase_unit_price: num(input.costPrice ?? existing?.purchase_unit_price),
    image: "",
    show_online: bool(existing ? existing.show_online : true),
    product_id: id,
    has_alternative_units: bool(existing?.has_alternative_units),
    product_unit: "",
    cess: num(existing?.cess),
    not_for_sale: bool(existing?.not_for_sale),
    discount: num(existing?.discount),
    discountAmount: num(existing?.discount_amount),
    show_discount_in: num(existing?.show_discount_in),
    has_batches: num(existing?.has_batches),
    // Opening stock is history, not something this form edits — round-trip it
    // or an edit would rewrite what the product started with.
    opening_qty: num(existing?.opening_qty),
    opening_purchase_price: num(existing?.opening_purchase_price),
    opening_value: num(existing?.opening_value),
    cess_on_qty: num(existing?.cess_on_qty),
    low_stock: num(input.lowStockAt ?? existing?.low_stock),
    cess_non_advl_rate: "",
    branch_price_confirmation_showed: "false",
    combo_items: "[]",
    visibility: "1",
    has_serial_number: "",
    unit: input.unit || String(existing?.unit ?? "PCS"),
    "Number of Hours": String(existing?.["Number of Hours"] ?? ""),
    "Number of Plays": String(existing?.["Number of Plays"] ?? ""),
    "Validity (in Months)": String(existing?.["Validity (in Months)"] ?? ""),
    is_purchase_price_with_tax: bool(existing ? existing.is_purchase_price_with_tax : true),
    max_product_discount: "null",
    tax_type: "",
    is_update_prices: "true",
    custom_fields: BLANK_CUSTOM_FIELDS,
    variants: "[]",
    has_multiple_tax: num(existing?.has_multiple_tax),
    multiple_tax_rates: "[]",
  };
}

/** Who made the change. The tier is verified; the name is what they typed. */
export interface Actor {
  name: string;
  tier: "counter" | "owner";
}

/**
 * Add a product to the Swipe catalogue. Names must be unique.
 *
 * The history row is written after Swipe accepts it, not before — logging a
 * creation that was then rejected would be worse than not logging it. It's
 * also best-effort: a Postgres hiccup must not fail a change Swipe has already
 * made, or the two would disagree about whether the product exists.
 */
export async function createProduct(input: ProductInput, actor: Actor): Promise<void> {
  const created = await swipeMultipart<{ product_id?: number; id?: number }>(
    "product",
    "add",
    productForm(input)
  );
  const newId = Number(created.product_id ?? created.id ?? 0);
  try {
    await recordProductChange({
      swipeProductId: newId,
      productName: input.name,
      action: "created",
      before: null,
      after: snapshotOf(input),
      by: actor.name,
      tier: actor.tier,
    });
  } catch (err) {
    console.error("product history (create) failed:", err);
  }
}

/** Edit one, preserving everything the form doesn't set. */
export async function updateProduct(
  productId: number,
  input: ProductInput,
  actor: Actor
): Promise<void> {
  const existing = await getProductDetails(productId);
  if (!existing) throw new Error("Product not found");

  const before = snapshotOfSwipe(existing);
  const after = snapshotOf(input);
  await swipeMultipart("product", "update", productForm(input, existing));

  // Re-saving the form untouched isn't a change, and logging it would bury the
  // edits that matter — same rule the cash ledger's history follows.
  if (!changed(before, after)) return;
  try {
    await recordProductChange({
      swipeProductId: productId,
      productName: input.name,
      action: "updated",
      before,
      after,
      by: actor.name,
      tier: actor.tier,
    });
  } catch (err) {
    console.error("product history (update) failed:", err);
  }
}

/* eslint-enable @typescript-eslint/no-explicit-any */
