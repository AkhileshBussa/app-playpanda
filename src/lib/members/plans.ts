/**
 * Membership plan catalog — the single source of truth for the fixed plan set.
 *
 * The membership SALE stays a manual step in Swipe (the manager bills the
 * membership product at the counter, unchanged). This app records the
 * membership and its visits, and punches each visit as a ₹0 invoice with the
 * plan's PUNCH product, so the ops monitor and Swipe history line up.
 *
 * Product ids mirror the Swipe catalog (company 2430519), same convention as
 * PACKAGES in ../pricing.ts. Plays/hours/validity were read off each product's
 * custom fields ("Number of Plays", "Number of Hours", "Validity (in Months)").
 */

export interface MembershipPlan {
  key: string;
  name: string;
  /** Swipe product billed manually at purchase (informational only here). */
  saleProductId: number;
  /** Swipe punch product used for each visit's ₹0 invoice. */
  punchProductId: number;
  punchProductName: string;
  /** null = unlimited plays during validity (used with oncePerDay). */
  totalPlays: number | null;
  hoursPerPlay: number;
  /** Kids covered by one play; extra kids consume extra plays. */
  kidsPerPlay: number;
  validityMonths: number;
  /** Tax-inclusive price, INR — informational, the sale is billed in Swipe. */
  priceWithTax: number;
  taxRatePercent: number;
  weekdaysOnly: boolean;
  oncePerDay: boolean;
  blurb: string;
}

export const MEMBERSHIP_PLANS: MembershipPlan[] = [
  {
    key: "fun-five",
    name: "Fun Five Pass",
    saleProductId: 6,
    punchProductId: 160,
    punchProductName: "Fun Five Pass - Punch",
    totalPlays: 5,
    hoursPerPlay: 2,
    kidsPerPlay: 1,
    validityMonths: 6,
    priceWithTax: 2499,
    taxRatePercent: 18,
    weekdaysOnly: false,
    oncePerDay: false,
    blurb: "5 plays · 2 hrs each · 6 months",
  },
  {
    key: "pro-12",
    name: "Panda Pro 12",
    saleProductId: 7,
    punchProductId: 162,
    punchProductName: "Panda Pro 12 - Punch",
    totalPlays: 12,
    hoursPerPlay: 2,
    kidsPerPlay: 1,
    validityMonths: 12,
    priceWithTax: 4999,
    taxRatePercent: 18,
    weekdaysOnly: false,
    oncePerDay: false,
    blurb: "12 plays · 2 hrs each · 12 months",
  },
  {
    key: "max-25",
    name: "Panda Max 25",
    saleProductId: 8,
    punchProductId: 161,
    punchProductName: "Panda Max 25 - Punch",
    totalPlays: 25,
    hoursPerPlay: 2,
    kidsPerPlay: 1,
    validityMonths: 12,
    priceWithTax: 7999,
    taxRatePercent: 18,
    weekdaysOnly: false,
    oncePerDay: false,
    blurb: "25 plays · 2 hrs each · 12 months",
  },
  {
    key: "supervised",
    name: "Supervised Play Pass",
    saleProductId: 9,
    punchProductId: 163,
    punchProductName: "Supervised Play Pass - Punch",
    totalPlays: null,
    hoursPerPlay: 4,
    kidsPerPlay: 1,
    validityMonths: 1,
    priceWithTax: 5999,
    taxRatePercent: 18,
    weekdaysOnly: true,
    oncePerDay: true,
    blurb: "Once a day · 4 hrs · Mon–Fri · 1 month",
  },
];

/** Custom plans must still punch against one of these existing Swipe products. */
export const PUNCH_PRODUCTS = MEMBERSHIP_PLANS.map((p) => ({
  id: p.punchProductId,
  name: p.punchProductName,
  taxRatePercent: p.taxRatePercent,
}));

export function getPlan(key: string): MembershipPlan | null {
  return MEMBERSHIP_PLANS.find((p) => p.key === key) ?? null;
}

export function getPunchProduct(id: number) {
  return PUNCH_PRODUCTS.find((p) => p.id === id) ?? null;
}

/**
 * date (YYYY-MM-DD) + N months, clamped to the target month's last day
 * (e.g. 31 Jan + 1 month → 28/29 Feb). Membership expiry is date-based in IST;
 * the expiry day itself is still usable.
 */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const targetMonthIndex = m - 1 + months;
  const lastDay = new Date(Date.UTC(y, targetMonthIndex + 1, 0)).getUTCDate();
  const end = new Date(Date.UTC(y, targetMonthIndex, Math.min(d, lastDay)));
  return end.toISOString().slice(0, 10);
}
