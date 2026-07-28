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

export type PackageId = (typeof PACKAGES)[number]["id"];

export interface BookingSelection {
  packageId: PackageId;
  kids: number;
  extraAdults: number;
  childSocks: number;
  adultSocks: number;
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

export interface Quote {
  lines: QuoteLine[];
  /** Tax-inclusive grand total, INR */
  total: number;
  packageLabel: string;
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

  return {
    lines,
    total: lines.reduce((sum, l) => sum + l.lineTotal, 0),
    packageLabel: `${pkg.label} · ${sel.kids} kid${sel.kids > 1 ? "s" : ""}`,
  };
}

export function round2(n: number) {
  return Math.round(n * 100) / 100;
}
