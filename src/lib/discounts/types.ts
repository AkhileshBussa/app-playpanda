/**
 * Discount codes — the domain types shared by the booking form, the ops tools
 * and the billing adapter.
 *
 * A "code" here covers both halves of how Play Panda actually gives discounts:
 * a code the counter hands out for people to type at self-checkout, and the
 * one-off "fine, ₹100 off" a manager grants when a family asks at the desk.
 * The second kind carries no code row (`codeId: null`, code `MANUAL`) but is
 * still a redemption, so both show up in one ledger.
 */

/** Percent off, or a flat ₹ amount off. */
export const DISCOUNT_KINDS = ["percent", "flat"] as const;
export type DiscountKind = (typeof DISCOUNT_KINDS)[number];

/**
 * How often a code may be used. The three modes the counter asked for:
 *   multi        — no limit at all (a standing "SCHOOL10")
 *   per_customer — unlimited overall, but N times per phone number
 *   single       — exactly one redemption across every customer
 */
export const DISCOUNT_USAGE = ["multi", "per_customer", "single"] as const;
export type DiscountUsage = (typeof DISCOUNT_USAGE)[number];

/** Where a code is allowed to be used. */
export const DISCOUNT_CHANNELS = ["online", "counter"] as const;
export type DiscountChannel = (typeof DISCOUNT_CHANNELS)[number];

export interface DiscountCode {
  id: string;
  /** Stored and compared uppercase; what the customer types. */
  code: string;
  kind: DiscountKind;
  /** 20 = 20% off (percent) or ₹20 off (flat). */
  value: number;
  /** Cap on a percent code, ₹. Null = uncapped. Ignored for flat codes. */
  maxDiscount: number | null;
  /** Minimum booking value the code applies to, ₹. 0 = no minimum. */
  minOrder: number;
  usage: DiscountUsage;
  /** Redemptions allowed per phone number (usage = per_customer). */
  perCustomerLimit: number | null;
  /** Redemptions allowed in total (1 for single-use; null = unlimited). */
  totalLimit: number | null;
  /** Unix ms; null = live immediately / never expires. */
  startsAt: number | null;
  expiresAt: number | null;
  active: boolean;
  /** Which checkouts may use it — at least one entry. */
  channels: DiscountChannel[];
  /** Why it exists, for whoever reads the list later. */
  note: string;
  createdByEmployeeId: string | null;
  createdByName: string;
  createdAt: number;
  /** Redemptions so far (released ones don't count). Filled by list queries. */
  timesUsed: number;
}

/** What a code (or a one-off grant) took off one booking. */
export interface DiscountRedemption {
  id: string;
  /** Null for a one-off counter grant that isn't backed by a code row. */
  codeId: string | null;
  /** Denormalised so the ledger still reads right if a code is renamed. */
  code: string;
  /** Our customers-table id; null for a counter one-off with no phone. */
  customerId: string | null;
  /** Joined from the customer row for display; '' when unknown. */
  phone: string;
  customerName: string;
  /** Our invoices-table id; null until the invoice exists (or if its mirror
   *  write failed — the number below still reads from metadata). */
  invoiceId: string | null;
  /** Invoice the discount landed on, e.g. "INV-1742". */
  invoice: string;
  /** Booking value before the discount, ₹. */
  gross: number;
  /** ₹ taken off. */
  discount: number;
  /** What's actually billed, ₹. */
  net: number;
  channel: DiscountChannel;
  /** `released` = the invoice was cancelled, so the code is free again. */
  status: "applied" | "released";
  /** Gateway handles, for tying a discounted booking back to its payment. */
  rzpOrderId: string;
  rzpPaymentId: string;
  /** Who granted it at the counter; empty for a self-checkout redemption. */
  appliedByEmployeeId: string | null;
  appliedByName: string;
  /** Free-text reason, on one-off counter grants. */
  reason: string;
  createdAt: number;
}

/** Why a code was refused. Mapped to customer- or counter-facing copy. */
export type DiscountRefusal =
  | "not_found"
  | "inactive"
  | "not_started"
  | "expired"
  | "wrong_channel"
  | "min_order"
  | "exhausted"
  | "customer_limit";

export const REFUSAL_MESSAGES: Record<DiscountRefusal, string> = {
  not_found: "That code isn't valid",
  inactive: "That code is no longer active",
  not_started: "That code isn't active yet",
  expired: "That code has expired",
  wrong_channel: "That code can't be used here",
  min_order: "Your booking is below this code's minimum",
  exhausted: "That code has already been used",
  customer_limit: "You've already used that code",
};

/** Refused with a reason the caller can turn into copy. */
export class DiscountError extends Error {
  constructor(readonly refusal: DiscountRefusal) {
    super(REFUSAL_MESSAGES[refusal]);
    this.name = "DiscountError";
  }
}
