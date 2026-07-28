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

/** Returning-customer details, for prefilling the booking form. */
export interface CustomerProfile {
  name: string;
  kidNames: string[];
}

export interface BookingLine {
  name: string;
  quantity: number;
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

  /** Read-only connectivity/auth diagnostics. */
  health(): Promise<Record<string, unknown>>;
}
