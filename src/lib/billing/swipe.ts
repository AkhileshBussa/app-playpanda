/**
 * Swipe billing ADAPTER — implements BillingProvider against Swipe's internal
 * API (app.getswipe.in), the same endpoints the Swipe web app itself calls.
 * All Swipe-specific payloads, ids, and quirks are contained in this file.
 *
 * Auth: the Swipe session token pp-billing keeps in Upstash Redis (`swipe:token`),
 * with SWIPE_API_TOKEN as an env fallback.
 *
 * To move to a different backend, write a new adapter implementing
 * BillingProvider and swap the export in ./index.ts — nothing else changes.
 */

import { round2 } from "../pricing";
import type {
  Booking,
  BookingDetails,
  BillingProvider,
  CreateBookingInput,
  CustomerProfile,
  InvoiceLine,
  RecordPaymentInput,
} from "./types";

const SWIPE_BASE_URL = "https://app.getswipe.in/api";
const TOKEN_KEY = "swipe:token";
/** The bank the counter records against (HDFC — bank_id 1 in this account). */
const DEFAULT_BANK_ID = 1;
/**
 * Customer custom-field ids in this Swipe account (company 2430519). Kid names
 * map to Child 1..4 (ids 3/5/7/9); only 4 slots exist, so extra kids are kept
 * on the invoice notes instead. The add payload sends all fields.
 */
const ALL_CUSTOM_FIELD_IDS = ["2", "3", "5", "6", "7", "8", "9", "10", "11", "13"] as const;
const CHILD_FIELD_IDS = ["3", "5", "7", "9"] as const;
/**
 * Document-level custom header "Validation Code" (header_id 1, document_type
 * invoice) — the single place the code lives on the invoice. Written on create
 * and read back on the confirmation screen.
 */
const VALIDATION_CODE_HEADER = { headerId: 1, name: "Validation Code" } as const;

class SwipeError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown) {
    super(message);
    this.name = "SwipeError";
  }
}

interface SwipeResponse {
  success?: boolean;
  message?: string;
  error_code?: string;
  [key: string]: unknown;
}

// ── Auth + transport ────────────────────────────────────────────────────────

let cachedToken: { value: string; fetchedAt: number } | null = null;
const TOKEN_CACHE_MS = 60_000;

async function getSwipeToken(): Promise<string> {
  if (cachedToken && Date.now() - cachedToken.fetchedAt < TOKEN_CACHE_MS) {
    return cachedToken.value;
  }

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (kvUrl && kvToken) {
    try {
      const res = await fetch(`${kvUrl}/get/${TOKEN_KEY}`, {
        headers: { Authorization: `Bearer ${kvToken}` },
        cache: "no-store",
      });
      const body = (await res.json()) as { result?: string | null };
      if (body.result) {
        cachedToken = { value: body.result, fetchedAt: Date.now() };
        return body.result;
      }
    } catch (err) {
      console.error("failed to read swipe:token from Redis:", err);
    }
  }

  const envToken = process.env.SWIPE_API_TOKEN;
  if (envToken) return envToken;
  throw new Error(
    "No Swipe token available — expected Redis `swipe:token` (refresh via pp-billing /settings) or SWIPE_API_TOKEN"
  );
}

/**
 * Mirrors the web app's getAPI(prefix, action, payload). Throws on failure
 * unless `allowFailure` is set — some endpoints (e.g. doc/create) return
 * success:false with a `warning` the caller must act on rather than throw.
 */
async function swipeCall<T extends SwipeResponse>(
  prefix: string,
  action: string,
  payload: Record<string, unknown>,
  opts?: { allowFailure?: boolean }
): Promise<T> {
  const token = await getSwipeToken();
  const res = await fetch(`${SWIPE_BASE_URL}/${prefix}/${action}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as T;
  if (opts?.allowFailure) return body;
  if (!res.ok || body.success === false) {
    console.error(`Swipe ${prefix}/${action} failed (${res.status}):`, JSON.stringify(body));
    throw new SwipeError(body.message || `Swipe API error (${res.status})`, res.status, body);
  }
  return body;
}

/** Today's date in IST, DD-MM-YYYY — the format Swipe expects. */
function swipeDateToday(): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")}-${get("month")}-${get("year")}`;
}

function taxBreakup(priceWithTax: number, taxRatePercent: number, quantity: number) {
  const unitPrice = round2(priceWithTax / (1 + taxRatePercent / 100));
  return {
    unit_price: unitPrice,
    net_amount: round2(unitPrice * quantity),
    total_amount: round2(priceWithTax * quantity),
    tax_amount: round2(priceWithTax * quantity - unitPrice * quantity),
  };
}

// ── Customers ────────────────────────────────────────────────────────────────

interface CustomField {
  custom_field_id?: number;
  name?: string;
  value?: string;
}

interface ExistingParty {
  customer_id?: number | string;
  id?: number | string;
  name?: string;
  phone?: string;
  custom_fields?: CustomField[];
}

function parseKidNames(fields: CustomField[] | undefined): string[] {
  return (fields ?? [])
    .filter((f) => /^child\s*\d+$/i.test((f.name ?? "").trim()) && (f.value ?? "").trim())
    .sort(
      (a, b) =>
        parseInt((a.name ?? "").replace(/\D/g, ""), 10) -
        parseInt((b.name ?? "").replace(/\D/g, ""), 10)
    )
    .map((f) => (f.value ?? "").trim());
}

/** Build the custom_fields/custom_values object the add API expects (keyed by field id). */
function buildCustomFieldsObject(kidNames: string[]): Record<string, string> {
  const obj: Record<string, string> = {};
  for (const id of ALL_CUSTOM_FIELD_IDS) obj[id] = "";
  kidNames
    .map((n) => n.trim())
    .filter(Boolean)
    .slice(0, CHILD_FIELD_IDS.length)
    .forEach((name, i) => {
      obj[CHILD_FIELD_IDS[i]] = name;
    });
  return obj;
}

async function findPartyIdByPhone(phone: string): Promise<number | null> {
  const dup = await swipeCall<SwipeResponse & { is_duplicate?: boolean; existing_parties?: ExistingParty[] }>(
    "v2/customer",
    "check_existing_party_with",
    { key: "phone", value: phone, exclude_customer_id: -1, party_type: "customer" }
  );
  if (dup.is_duplicate && dup.existing_parties?.length) {
    const p = dup.existing_parties[0];
    const id = p.customer_id ?? p.id;
    if (id != null) return Number(id);
  }
  return null;
}

/** Returns the customer id, reusing an existing customer or creating a new one. */
async function ensureCustomer(customer: {
  name: string;
  phone: string;
  kidNames: string[];
}): Promise<number | null> {
  try {
    const existing = await findPartyIdByPhone(customer.phone);
    if (existing != null) return existing; // reuse — never edit an existing customer
  } catch (err) {
    console.error("customer lookup failed, will try create:", err);
  }

  const customFields = buildCustomFieldsObject(customer.kidNames);
  await swipeCall("v2/customer", "add", {
    customer_id: -1,
    name: customer.name,
    phone: Number(customer.phone),
    gst: 0,
    email: "",
    discount: 0,
    customer_discount_type: 0,
    gstin: "",
    company_name: "",
    opening_balance: 0,
    balance: 0,
    is_same: false,
    credit_limit: 0,
    billing: { address_1: "", address_2: "", city: "", pincode: "" },
    shipping: { is_same: false, address_1: "", address_2: "", city: "", pincode: "" },
    billing_address: [],
    shipping_address: [],
    opening_balance_type: 1,
    dial_code: "91",
    profile_image: "",
    shopify_party_id: "",
    is_tds: false,
    is_tcs: false,
    is_rcm: false,
    custom_values: customFields,
    tags: [],
    export_customer: 0,
    cc_emails: "",
    custom_fields: customFields,
    is_sez: false,
    is_ecom: false,
    force_add_customer: true,
    bank_details: [],
    is_existing_customer_check: 1,
  });

  // The add response id shape varies; re-look up by phone to get the party id.
  return findPartyIdByPhone(customer.phone);
}

// ── Invoices ─────────────────────────────────────────────────────────────────

let cachedPrefix: string | null = null;

async function getInvoicePrefix(): Promise<string> {
  if (cachedPrefix == null) {
    const res = await swipeCall<SwipeResponse & { prefixes?: Array<{ prefix?: string; is_default?: number }> }>(
      "utils",
      "get_document_prefix",
      { document_type: "invoice" }
    );
    const list = res.prefixes ?? [];
    cachedPrefix = String((list.find((p) => p.is_default) ?? list[0])?.prefix ?? "");
  }
  return cachedPrefix;
}

async function getNextInvoiceSerial(): Promise<{ docNumber: number; serialNumber: string }> {
  const prefix = await getInvoicePrefix();
  const res = await swipeCall<SwipeResponse & { doc_number?: number; default_prefix?: string }>(
    "utils",
    "get_prefix_seral_number",
    { prefix, document_type: "invoice", suffix: "", is_prefix: true }
  );
  const usedPrefix = res.default_prefix ?? prefix;
  const docNumber = Number(res.doc_number ?? 0);
  return { docNumber, serialNumber: `${usedPrefix}${docNumber}` };
}

function toSwipeItem(line: InvoiceLine) {
  const b = taxBreakup(line.priceWithTax, line.taxRatePercent, line.quantity);
  return {
    product_id: Number(line.sku),
    variant_id: 0,
    batch_id: 0,
    product_name: line.name,
    variant_name: "",
    qty: line.quantity,
    free_qty: 0,
    conversion_rate: 1,
    unit_price: b.unit_price,
    tax: line.taxRatePercent,
    cess: 0,
    cess_on_qty: 0,
    discount: 0,
    cess_on_qty_value: 0,
    is_discount_percent: 1,
    discount_net_value: 0,
    discount_price_with_tax_value: 0,
    discount_unit_price_value: 0,
    discount_value: 0,
    item_custom_columns: [] as Array<{ id: number; name: string; value: string }>,
    purchase_unit_price: 0,
    description: "",
    unit: "",
    price_with_tax: line.priceWithTax,
    net_amount: b.net_amount,
    total_amount: b.total_amount,
    cess_amount: 0,
    tax_amount: b.tax_amount,
  };
}

interface CreateResp extends SwipeResponse {
  hash_id?: string;
  new_hash_id?: string;
  serial_number?: string;
  doc_count?: number;
  warning?: boolean;
  new_serial_number?: string;
  new_doc_number?: number;
}

/** Provider-specific handle carried in Booking.ref (opaque to callers). */
interface SwipeRef {
  serialNumber: string;
  docCount: number;
  partyId: number | null;
}

async function createSwipeInvoice(
  input: CreateBookingInput,
  customerId: number | null
): Promise<{ invoiceNumber: string; docCount: number }> {
  const date = swipeDateToday();
  const items = input.lines.map(toSwipeItem);
  const totalAmount = round2(items.reduce((s, i) => s + i.total_amount, 0));
  const netAmount = round2(items.reduce((s, i) => s + i.net_amount, 0));
  const taxAmount = round2(totalAmount - netAmount);

  // The validation code lives ONLY in the document custom header (below). Notes
  // just carry the kids' names for the counter; reference is a plain label.
  const kids = input.customer.kidNames.filter(Boolean);
  const reference = "Play Panda booking";
  const notes = kids.length ? `Kids: ${kids.join(", ")}` : "";

  const { docNumber, serialNumber } = await getNextInvoiceSerial();

  const build = (docNo: number, serial: string): Record<string, unknown> => ({
    id: -1,
    project_id: -1,
    document_type: "invoice",
    invoice_type: "b2b",
    source: 0,
    doc_number: docNo,
    suffix: "",
    serial_number: serial,
    document_title: "Invoice",
    doc_without_items: 0,
    party_details: {},
    send_pos_sms: 0,
    party_ids: customerId != null ? [customerId] : [],
    ecommerce_gstin: "",
    ecommerce_name: "",
    document_date: date,
    due_date: date,
    items,
    warehouse_id: -1,
    total_amount: totalAmount,
    tax_amount: taxAmount,
    cess_amount: 0,
    cess_on_qty_value: 0,
    extra_discount: 0,
    net_amount: netAmount,
    total_discount: 0,
    discount_type: "total_amount",
    roundoff: 1,
    roundoff_value: 0,
    with_tax: 1,
    rcm: 0,
    subscription_payment_type: "manual",
    start_subscription_on_payment: 1,
    bank_id: DEFAULT_BANK_ID,
    terms: "",
    notes,
    reference,
    is_draft: false,
    is_pos: false,
    skip_warning: false,
    customer_shipping_addr_id: -1,
    company_shipping_addr_id: -1,
    place_of_supply: "",
    order_serial_number: "",
    supplier_invoice_date: date,
    supplier_invoice_serial_number: "",
    is_tds: 0,
    tds_under_gst_amount: 0,
    is_tcs: 0,
    tds_details: { tds_amount: 0, apply_on: "net_amount" },
    tcs_details: { tcs_amount: 0, apply_on: "total_amount" },
    immovable_tax_type: 0,
    hide_totals: 0,
    coupon_details: { coupon_id: -1, coupon_code: "", discount: 0, message: "", is_edit: false },
    rzp_order_id: "",
    rzp_payment_id: "",
    show_description: 0,
    has_extra_charges: 0,
    exclusive_notes: "",
    signature: "",
    is_export: 0,
    is_multi_currency: 0,
    export_invoice_details: {
      shipping_bill_date: "",
      shipping_bill_number: "",
      shipping_port_code: "",
      export_type: "",
      conversion_factor: 1,
      country_id: 179,
      currency_id: 1,
    },
    is_subscription: 0,
    subscription: {
      start_time: date,
      end_time: date,
      repeat: 1,
      repeat_type: "days",
      send_email: 0,
      send_sms: 0,
      send_wtsp: 0,
      sub_serial_number: "",
      subscription_document_type: "invoice",
      payment_type: "manual",
      start_subscription_on_payment: 1,
    },
    is_created_by_recurring: 0,
    sub_serial_number: "",
    convert: { convert_from: "", doc_count: 0 },
    convert_list: [],
    document_custom_additional_charges: [],
    document_item_headers: [],
    attachments: [],
    document_custom_headers: [
      { header_id: VALIDATION_CODE_HEADER.headerId, value: input.validationCode },
    ],
    payments: [],
    price_list_id: 0,
    waiting_for_approval: false,
    is_shopify: false,
  });

  // The suggested serial can collide (numbering drift / concurrent bookings);
  // Swipe returns a warning with the correct next number, so retry with it.
  let res = await swipeCall<CreateResp>("v3/doc", "create", build(docNumber, serialNumber), {
    allowFailure: true,
  });
  for (let tries = 0; res.success === false && res.warning && res.new_serial_number && tries < 4; tries++) {
    const retry = build(Number(res.new_doc_number) || docNumber, res.new_serial_number);
    retry.skip_warning = true;
    res = await swipeCall<CreateResp>("v3/doc", "create", retry, { allowFailure: true });
  }

  if (res.success === false) {
    console.error("Swipe v3/doc/create failed:", JSON.stringify(res));
    throw new Error(res.message || "Swipe invoice creation failed");
  }
  const hashId = res.new_hash_id || res.hash_id;
  if (!hashId) throw new Error(`Swipe create did not return a document id: ${JSON.stringify(res)}`);
  return {
    invoiceNumber: res.serial_number || serialNumber,
    docCount: Number(res.doc_count ?? 0),
  };
}

// ── Provider ─────────────────────────────────────────────────────────────────

export const swipeBilling: BillingProvider = {
  name: "swipe",

  async findCustomerByPhone(phone: string): Promise<CustomerProfile | null> {
    const id = await findPartyIdByPhone(phone);
    if (id == null) return null;
    const res = await swipeCall<SwipeResponse & { customer_details?: ExistingParty[] }>(
      "v2/customer",
      "get_details",
      { id }
    );
    const details = res.customer_details?.[0];
    return { name: details?.name ?? "", kidNames: parseKidNames(details?.custom_fields) };
  },

  async createBooking(input: CreateBookingInput): Promise<Booking> {
    const customerId = await ensureCustomer(input.customer);
    const { invoiceNumber, docCount } = await createSwipeInvoice(input, customerId);
    const ref: SwipeRef = { serialNumber: invoiceNumber, docCount, partyId: customerId };
    return { invoiceNumber, ref: JSON.stringify(ref) };
  },

  async getBookingByInvoiceNumber(invoiceNumber: string): Promise<BookingDetails | null> {
    const prefix = await getInvoicePrefix();
    const serial = invoiceNumber.startsWith(prefix) ? invoiceNumber : `${prefix}${invoiceNumber}`;

    // Find the invoice by exact serial (search is fuzzy → filter for the match).
    const txns = await swipeCall<SwipeResponse & { transactions?: Array<Record<string, unknown>> }>(
      "v2/doc",
      "get_transactions",
      {
        num_records: 20,
        page: 0,
        payment_status: 0,
        search: serial,
        search_type: "serial_no",
        filters: { invoice_type: [], payment_mode: "", filtered_users: [], status: "", is_export: false, type_of_doc: [], prefixes: [] },
        date: "",
        document_type: "invoice",
        sort_type: "",
        sort_order: "",
      }
    );
    const match = (txns.transactions ?? []).find((t) => t.serial_number === serial);
    if (!match?.new_hash_id) return null;

    const d = await swipeCall<SwipeResponse & { invoice_details?: Record<string, unknown> }>(
      "v2/doc",
      "get_invoice",
      { new_hash_id: match.new_hash_id, document_type: "invoice", is_pdf: false }
    );
    const inv = d.invoice_details;
    if (!inv) return null;

    const items = (inv.items as Array<Record<string, unknown>>) ?? [];

    // The validation code is the "Validation Code" document custom header.
    const docHeaders = (inv.document_custom_headers as Array<Record<string, unknown>>) ?? [];
    const header = docHeaders.find(
      (h) =>
        Number(h.header_id) === VALIDATION_CODE_HEADER.headerId ||
        /validation code/i.test(String(h.label ?? h.name ?? ""))
    );
    const headerValue = header?.value;
    const validationCode =
      headerValue != null && String(headerValue).trim() ? String(headerValue).trim() : null;

    const customer = inv.customer as { name?: string } | undefined;
    return {
      invoiceNumber: String(inv.serial_number ?? serial),
      validationCode,
      customerName: customer?.name ?? "",
      amount: Number(inv.total_amount ?? 0),
      paid: String(inv.payment_status ?? "").toLowerCase() === "paid",
      lines: items.map((it) => ({
        name: String(it.name ?? it.product_name ?? ""),
        quantity: Number(it.qty ?? it.quantity ?? 1),
      })),
    };
  },

  async recordPayment(input: RecordPaymentInput): Promise<void> {
    const { serialNumber, docCount, partyId } = JSON.parse(input.ref) as SwipeRef;
    await swipeCall("v3/payments", "create_payment", {
      payments: [
        {
          documents: [
            {
              serial_number: serialNumber,
              amount_settled: input.amount,
              doc_count: docCount,
              document_type: "invoice",
            },
          ],
          payment_date: swipeDateToday(),
          notes: input.transactionRef ? `Ref ${input.transactionRef}` : "",
          utr_id: input.transactionRef ?? "",
          party_id: partyId,
          party_type: "customer",
          amount: input.amount,
          payment_mode: input.method,
          bank_id: DEFAULT_BANK_ID,
          payment_type: "in",
          tds_details: { apply_on: "net_amount", is_tds: 0 },
          attachments: [],
          signature: "",
          send_sms: false,
          send_email: false,
          exclusive_notes: "",
          is_edit: false,
          project_id: -1,
        },
      ],
    });
  },

  async health(): Promise<Record<string, unknown>> {
    const report: Record<string, unknown> = { provider: "swipe" };
    let token: string;
    try {
      token = await getSwipeToken();
      report.token = { present: true, length: token.length };
      try {
        const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
        report.token = {
          ...(report.token as object),
          company_id: payload.company_id,
          issued_at: payload.iat ? new Date(payload.iat * 1000).toISOString() : undefined,
        };
      } catch {
        // opaque (non-JWT) token — fine
      }
    } catch (err) {
      report.token = { present: false, error: err instanceof Error ? err.message : String(err) };
      report.ok = false;
      return report;
    }

    try {
      await swipeCall("v2/customer", "check_existing_party_with", {
        key: "phone",
        value: "0000000000",
        exclude_customer_id: -1,
        party_type: "customer",
      });
      report.ok = true;
    } catch (err) {
      report.ok = false;
      report.error = err instanceof Error ? err.message : String(err);
    }
    return report;
  },
};
