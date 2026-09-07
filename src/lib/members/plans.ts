/**
 * Membership plan catalog — the single source of truth for the fixed plan set.
 *
 * This app is where a membership is SOLD: recording it bills the plan's SALE
 * product as an invoice in Swipe (and takes the payment), then punches each
 * visit as a ₹0 invoice with the plan's PUNCH product, so the ops monitor and
 * Swipe history line up.
 *
 * Product ids mirror the Swipe catalog (company 2430519), same convention as
 * PACKAGES in ../pricing.ts. Plays/hours/validity were read off each product's
 * custom fields ("Number of Plays", "Number of Hours", "Validity (in Months)").
 */

export interface MembershipPlan {
  key: string;
  name: string;
  /** Swipe product this app bills the purchase on. */
  saleProductId: number;
  saleProductName: string;
  /** Swipe punch product used for each visit's ₹0 invoice. */
  punchProductId: number;
  punchProductName: string;
  /** null = unlimited plays during validity (used with oncePerDay). */
  totalPlays: number | null;
  hoursPerPlay: number;
  /** Kids covered by one play; extra kids consume extra plays. */
  kidsPerPlay: number;
  validityMonths: number;
  /** Tax-inclusive catalogue price, INR — what the sale invoice bills by default. */
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
    saleProductName: "Fun Five Pass",
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
    key: "fun-ten",
    name: "Fun Ten Pass",
    saleProductId: 199,
    saleProductName: "Fun Ten Pass",
    punchProductId: 200,
    punchProductName: "Fun Ten Pass - 1hr - Punch",
    totalPlays: 10,
    hoursPerPlay: 1,
    kidsPerPlay: 1,
    // Blank on the Swipe product (its "Validity (in Months)" was never filled);
    // 6 months chosen to match Fun Five Pass.
    validityMonths: 6,
    priceWithTax: 3499,
    taxRatePercent: 18,
    weekdaysOnly: false,
    oncePerDay: false,
    blurb: "10 plays · 1 hr each · 6 months",
  },
  {
    key: "pro-12",
    name: "Panda Pro 12",
    saleProductId: 7,
    saleProductName: "Panda Pro 12",
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
    saleProductName: "Panda Max 25",
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
    saleProductName: "Supervised Play Pass",
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

/**
 * Custom plans must still bill and punch against one of these existing Swipe
 * products — a custom plan has no catalogue entry of its own, so it borrows a
 * fixed plan's pair: the sale product carries its price, the punch product its
 * visits. Both keep the membership categories Swipe reports on.
 */
export const PUNCH_PRODUCTS = MEMBERSHIP_PLANS.map((p) => ({
  id: p.punchProductId,
  name: p.punchProductName,
  taxRatePercent: p.taxRatePercent,
  saleProductId: p.saleProductId,
  saleProductName: p.saleProductName,
}));

export function getPlan(key: string): MembershipPlan | null {
  return MEMBERSHIP_PLANS.find((p) => p.key === key) ?? null;
}

export function getPunchProduct(id: number) {
  return PUNCH_PRODUCTS.find((p) => p.id === id) ?? null;
}

export function getSaleProductFor(plan: {
  planKey: string;
  punchProductId: number;
}): { id: number; name: string; taxRatePercent: number } | null {
  const fixed = getPlan(plan.planKey);
  if (fixed) {
    return {
      id: fixed.saleProductId,
      name: fixed.saleProductName,
      taxRatePercent: fixed.taxRatePercent,
    };
  }
  const punch = getPunchProduct(plan.punchProductId);
  return punch
    ? { id: punch.saleProductId, name: punch.saleProductName, taxRatePercent: punch.taxRatePercent }
    : null;
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
