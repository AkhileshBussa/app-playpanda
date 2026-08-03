/**
 * Billing provider PORT — the backend-agnostic contract the app depends on.
 *
 * Routes and UI talk only to a `BillingProvider`; they never know whether it's
 * Swipe, our own backend, or anything else. To swap backends, implement this
 * interface in a new adapter and change the single export in ./index.ts.
 *
 * Everything here is expressed in DOMAIN terms — no invoice hash ids, doc
 * counts, custom-field ids, or other provider specifics leak across this line.
 * Provider-specific handles are carried in the opaque `ref` string.
 */

export interface BookingCustomer {
  name: string;
  phone: string;
  /** Kid names (optional). The provider decides how to persist them. */
  kidNames: string[];
}

export interface InvoiceLine {
  /** Generic product id; the adapter maps it to its own catalog. */
  sku: string;
  name: string;
  itemType: "Product" | "Service";
  quantity: number;
  taxRatePercent: number;
  /** Tax-inclusive unit price, INR. */
  priceWithTax: number;
}

export interface CreateBookingInput {
  customer: BookingCustomer;
  lines: InvoiceLine[];
  /** Short code the customer shows and the counter validates against the invoice. */
  validationCode: string;
}

export interface Booking {
  /** Human-facing invoice number, e.g. "INV-1616". */
  invoiceNumber: string;
  /**
   * Opaque, provider-specific handle for this booking. Round-trips back to the
   * client and into recordPayment(); callers must treat it as an opaque token.
   */
  ref: string;
}

export interface RecordPaymentInput {
  /** The opaque `ref` returned by createBooking. */
  ref: string;
  /** Amount paid, INR. */
  amount: number;
  /** Payment method, e.g. "UPI", "Card". */
  method: string;
  /** Gateway transaction reference, if any (e.g. Razorpay payment id / UTR). */
  transactionRef?: string;
}

/**
 * One membership visit to punch as a ₹0 invoice. The punch product is what the
 * counter already bills manually for membership visits; quantity = plays
 * consumed (extra kids on one visit consume extra plays).
 */
export interface MembershipPunchInput {
  customer: BookingCustomer;
  punch: {
    /** Generic punch product id; the adapter maps it to its own catalog. */
    sku: string;
    name: string;
    taxRatePercent: number;
    /** Plays consumed by this visit. */
    quantity: number;
    /** Per-play duration — drives the session timer on the ops monitor. */
    hoursPerPlay: number;
    /** The plan's total plays (informational on the invoice line); null = unlimited. */
    totalPlays: number | null;
  };
  /** Free-text note for the counter (plan name, kids, etc.). */
  notes?: string;
}

/** Payment methods the counter can collect in. */
export const PAYMENT_METHODS = ["Cash", "Card", "UPI"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * A payment taken at the counter, against an invoice the staff can see rather
 * than the opaque booking `ref` (which only the booking flow holds).
 */
export interface CollectPaymentInput {
  /** Human invoice number, e.g. "INV-1712". */
  invoiceNumber: string;
  /** Amount collected now, INR. May be part of the outstanding balance. */
  amount: number;
  method: PaymentMethod;
  /** UPI/card reference, if the counter noted one. */
  transactionRef?: string;
}

/** State of the invoice after a payment lands. */
export interface PaymentResult {
  invoiceNumber: string;
  /** Still outstanding, INR — 0 once settled. */
  amountDue: number;
  paid: boolean;
}

/**
 * A membership SALE invoice from today — what the manager billed at the
 * counter before recording the membership. Offered as a pick-list so the sale
 * reference is chosen, not typed.
 */
export interface MembershipSaleInvoice {
  invoiceNumber: string;
  customerName: string;
  phone: string;
  /** Invoice grand total, INR (may include socks etc., not just the plan). */
  amount: number;
  /** When the invoice was created, unix ms. */
  at: number;
  /** The membership-plan lines on this invoice. */
  planLines: Array<{ sku: string; name: string; quantity: number }>;
}

/** Returning-customer details, for prefilling the booking form. */
export interface CustomerProfile {
  name: string;
  kidNames: string[];
}

export interface BookingLine {
  name: string;
  quantity: number;
  /** Line total incl. tax, INR. */
  amount: number;
}

/** A booking looked up by invoice number — the source of truth for the confirmation screen. */
export interface BookingDetails {
  /** Full invoice number, e.g. "INV-1616". */
  invoiceNumber: string;
  /** The validation code stored on the invoice, or null if not present. */
  validationCode: string | null;
  customerName: string;
  /** Grand total, INR. */
  amount: number;
  paid: boolean;
  lines: BookingLine[];
  /**
   * Play-session handles this invoice yields on the ops monitor (same ids the
   * check-in state is keyed by), with each session's play minutes. Lets the
   * confirmation screen show checked-in status and the computed end time.
   */
  playSessions: Array<{ id: string; durationMinutes: number }>;
}

/**
 * One live play session for the ops monitor — one card on the floor screen.
 * A single invoice can yield several sessions (e.g. two kids on different
 * packages), each with its own stable `id`.
 */
export interface TodaySession {
  /** Stable per-card handle (provider doc id, suffixed #i when an invoice splits). */
  id: string;
  /** Human-facing invoice number, e.g. "INV-1616". */
  invoiceNumber: string;
  kidNames: string[];
  parentName: string;
  phone: string;
  /** When the booking/invoice was created, unix ms. */
  bookedAt: number;
  /** Play duration in minutes; 0 = untimed (membership visit). */
  durationMinutes: number;
  /** Play-time product names on this session. */
  products: string[];
  kidCount: number;
  isMembership: boolean;
  paid: boolean;
  /** Amount still to collect on the invoice, INR (0 when fully paid; tracks partial payments). */
  amountDue: number;
  /**
   * The 4-digit code on app bookings (these require counter check-in before
   * the timer starts); null for counter walk-ins, whose timer runs from
   * `bookedAt`. Server-side only — never send this to the client.
   */
  validationCode: string | null;
}

/** Today's sales rollup for the ops monitor header. */
export interface DaySales {
  /** Sum of today's invoice totals, INR (billed, including unpaid). */
  total: number;
  /** Collected today, by payment mode. */
  cash: number;
  card: number;
  upi: number;
  other: number;
  invoiceCount: number;
}

export interface BillingProvider {
  /** Identifier for diagnostics, e.g. "swipe". */
  readonly name: string;

  /** Look up a customer by phone for form prefill; null when unknown. */
  findCustomerByPhone(phone: string): Promise<CustomerProfile | null>;

  /** Upsert the customer and create the (unpaid) invoice. */
  createBooking(input: CreateBookingInput): Promise<Booking>;

  /**
   * Fetch a booking by its invoice number (the number in the confirmation URL,
   * with or without any prefix). Source of truth for the confirmation screen.
   * Returns null if no such invoice exists.
   */
  getBookingByInvoiceNumber(invoiceNumber: string): Promise<BookingDetails | null>;

  /** Record a collected payment against the booking (marks the invoice paid). */
  recordPayment(input: RecordPaymentInput): Promise<void>;

  /**
   * Record a payment taken at the counter, addressed by invoice number.
   * Rejects more than the outstanding balance. Returns what's left owing.
   */
  collectPayment(input: CollectPaymentInput): Promise<PaymentResult>;

  /**
   * Punch one membership visit: upsert the customer and create the ₹0 invoice
   * with the punch product. Shows up on the ops monitor as a membership session.
   */
  createMembershipPunch(input: MembershipPunchInput): Promise<{ invoiceNumber: string }>;

  /**
   * Today's invoices carrying a membership-plan (sale) line, newest first —
   * the pick-list for linking a membership to the sale it was billed on.
   */
  listTodayMembershipSales(): Promise<MembershipSaleInvoice[]>;

  /**
   * All play sessions from today's invoices, for the ops session monitor.
   * Includes app bookings (with validationCode) and counter walk-ins.
   */
  listTodaySessions(): Promise<TodaySession[]>;

  /** Today's sales rollup (billed total + collected by mode), for the ops header. */
  getTodaySales(): Promise<DaySales>;

  /** Read-only connectivity/auth diagnostics. */
  health(): Promise<Record<string, unknown>>;
}
