/**
 * PlayPanda catalog & pricing — the single source of truth for the UI (live
 * total) and the server (authoritative amount). Backend-agnostic: each line
 * carries a generic `sku`; the billing adapter maps `sku` to its own product.
 *
 * `sku` values currently equal the Swipe product ids (company 2430519) so
 * invoices line up with counter billing. Swapping backends = remap these skus
 * in one place plus the new adapter.
 */

export const PACKAGES = [
  { id: "1hr", hours: 1, label: "1 Hour", pricePerKid: 499, taxRatePercent: 18, sku: "2", name: "Mini Adventure - 1hr", popular: false },
  { id: "2hr", hours: 2, label: "2 Hours", pricePerKid: 699, taxRatePercent: 18, sku: "3", name: "Panda's Favorite - 2hr", popular: true },
  { id: "3hr", hours: 3, label: "3 Hours", pricePerKid: 799, taxRatePercent: 18, sku: "4", name: "Panda Explorer Pass - 3hr", popular: false },
] as const;

export const SOCKS = {
  child: { price: 49, taxRatePercent: 18, sku: "181", name: "Socks - New - Size 2", label: "Kids socks" },
  adult: { price: 69, taxRatePercent: 5, sku: "134", name: "Socks Adults Size - 4", label: "Adult socks" },
} as const;

/** Entry policy: one adult comes in free with every child. */
export const FREE_ADULTS_PER_KID = 1;

/** Adults beyond the free allowance are billed as this product. */
export const EXTRA_ADULT = {
  price: 199,
  taxRatePercent: 18,
  sku: "129",
  name: "Extra Adult",
  label: "Extra adult",
} as const;

/**
 * Extra play time, sold in half-hour blocks (Swipe product 13).
 *
 * A counter-only add-on: the website sells a longer package, it doesn't sell
 * extensions. This is for a family already inside who wants to stay on, so it
 * only ever appears when a booking is edited.
 *
 * One block buys 30 minutes for ONE kid — the ops board divides the invoice's
 * total extra minutes across the kids on it, so a two-kid session that wants
 * another half hour each takes two blocks. That's how the counter already
 * billed it by hand in Swipe, and the board's timer already reads it back.
 */
export const EXTRA_30_MIN = {
  price: 199,
  taxRatePercent: 18,
  sku: "13",
  name: "Extra 30 Minutes",
  label: "Extra 30 min",
} as const;

export type PackageId = (typeof PACKAGES)[number]["id"];

export interface BookingSelection {
  packageId: PackageId;
  kids: number;
  extraAdults: number;
  childSocks: number;
  adultSocks: number;
  /**
   * Half-hour extensions. Optional because only the counter's edit sheet can
   * set it — the customer-facing form has no notion of extending a session
   * that hasn't started.
   */
  extra30?: number;
}

export interface QuoteLine {
  /** Generic product id; the billing adapter maps it to its own catalog. */
  sku: string;
  /** Product name (what shows on the invoice). */
  name: string;
  /** Friendly name shown in the UI. */
  displayName: string;
  itemType: "Product" | "Service";
  quantity: number;
  taxRatePercent: number;
  /** Tax-inclusive price per unit, INR */
  priceWithTax: number;
  /** Tax-inclusive line total, INR */
  lineTotal: number;
}

/** A discount that's already been priced — see applyDiscount. */
export interface AppliedDiscount {
  /** The code as typed, or "MANUAL" for a one-off counter grant. */
  code: string;
  /** ₹ off. Computed server-side; the client only ever displays it. */
  amount: number;
}

export interface Quote {
  lines: QuoteLine[];
  /** Tax-inclusive grand total, INR — already net of `discount` when set. */
  total: number;
  packageLabel: string;
  /** Total before any discount, INR. Equals `total` when nothing was applied. */
  gross: number;
  /** Set only when a discount was applied. */
  discount?: AppliedDiscount;
}

export function getPackage(packageId: PackageId) {
  const pkg = PACKAGES.find((p) => p.id === packageId);
  if (!pkg) throw new Error(`Unknown package: ${packageId}`);
  return pkg;
}

export function computeQuote(sel: BookingSelection): Quote {
  const pkg = getPackage(sel.packageId);
  const lines: QuoteLine[] = [
    {
      sku: pkg.sku,
      name: pkg.name,
      displayName: `Play session — ${pkg.label}`,
      itemType: "Service",
      quantity: sel.kids,
      taxRatePercent: pkg.taxRatePercent,
      priceWithTax: pkg.pricePerKid,
      lineTotal: pkg.pricePerKid * sel.kids,
    },
  ];

  if (sel.extraAdults > 0) {
    lines.push({
      sku: EXTRA_ADULT.sku,
      name: EXTRA_ADULT.name,
      displayName: EXTRA_ADULT.label,
      itemType: "Service",
      quantity: sel.extraAdults,
      taxRatePercent: EXTRA_ADULT.taxRatePercent,
      priceWithTax: EXTRA_ADULT.price,
      lineTotal: EXTRA_ADULT.price * sel.extraAdults,
    });
  }

  if ((sel.extra30 ?? 0) > 0) {
    lines.push({
      sku: EXTRA_30_MIN.sku,
      name: EXTRA_30_MIN.name,
      displayName: EXTRA_30_MIN.label,
      itemType: "Service",
      quantity: sel.extra30 ?? 0,
      taxRatePercent: EXTRA_30_MIN.taxRatePercent,
      priceWithTax: EXTRA_30_MIN.price,
      lineTotal: EXTRA_30_MIN.price * (sel.extra30 ?? 0),
    });
  }

  if (sel.childSocks > 0) {
    lines.push({
      sku: SOCKS.child.sku,
      name: SOCKS.child.name,
      displayName: SOCKS.child.label,
      itemType: "Product",
      quantity: sel.childSocks,
      taxRatePercent: SOCKS.child.taxRatePercent,
      priceWithTax: SOCKS.child.price,
      lineTotal: SOCKS.child.price * sel.childSocks,
    });
  }
  if (sel.adultSocks > 0) {
    lines.push({
      sku: SOCKS.adult.sku,
      name: SOCKS.adult.name,
      displayName: SOCKS.adult.label,
      itemType: "Product",
      quantity: sel.adultSocks,
      taxRatePercent: SOCKS.adult.taxRatePercent,
      priceWithTax: SOCKS.adult.price,
      lineTotal: SOCKS.adult.price * sel.adultSocks,
    });
  }

  const total = lines.reduce((sum, l) => sum + l.lineTotal, 0);
  return {
    lines,
    total,
    gross: total,
    packageLabel: `${pkg.label} · ${sel.kids} kid${sel.kids > 1 ? "s" : ""}`,
  };
}

export function round2(n: number) {
  return Math.round(n * 100) / 100;
}

/**
 * Money, the way it should read on screen: "₹699" for whole rupees, "₹1,188.30"
 * once there are paise. Discounts are the reason this exists — every catalogue
 * price is a whole number, but a percentage off almost never is, and a total
 * shown as "₹1,188.3" reads like a bug to the family being asked to pay it.
 */
export function formatInr(n: number): string {
  const paise = Math.abs(Math.round(n * 100) % 100) > 0;
  return `₹${n.toLocaleString("en-IN", {
    minimumFractionDigits: paise ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Re-price a quote with a discount, by scaling every line's tax-inclusive unit
 * price by the same ratio.
 *
 * Why scale the lines rather than subtract a lump off the total: the catalogue
 * spans two GST slabs (18% on play and extra adults, 5% on adult socks). A
 * single deduction at the bottom would have to be apportioned across those
 * slabs by someone, and doing it here — proportionally, at the line — keeps the
 * taxable value of each slab correct by construction. It's also the treatment a
 * discount given at the time of sale gets: recorded on the invoice, reducing
 * the taxable value, rather than a post-sale adjustment.
 *
 * The returned `discount.amount` is derived from the summed lines, not from the
 * requested figure, so the invoice, the gateway order and the ledger can never
 * disagree by a paisa. It can therefore land a few paise off the nominal
 * discount; that's the price of the three of them always matching.
 */
export function applyDiscount(quote: Quote, discount: AppliedDiscount): Quote {
  const gross = quote.gross;
  const off = Math.min(Math.max(discount.amount, 0), gross);
  if (gross <= 0 || off <= 0) return quote;

  const ratio = (gross - off) / gross;
  const lines = quote.lines.map((line) => {
    const priceWithTax = round2(line.priceWithTax * ratio);
    return { ...line, priceWithTax, lineTotal: round2(priceWithTax * line.quantity) };
  });
  const total = round2(lines.reduce((sum, l) => sum + l.lineTotal, 0));

  return {
    ...quote,
    lines,
    total,
    gross,
    discount: { code: discount.code, amount: round2(gross - total) },
  };
}
