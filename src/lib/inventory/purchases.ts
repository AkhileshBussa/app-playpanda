/**
 * Swipe PURCHASES — stock coming in.
 *
 * Buying socks is not an expense. The money turns into stock, and its cost is
 * booked when the stock is sold, not when it's bought — so the books count it
 * as inventory rather than spend. That's why the counter raises a purchase
 * invoice (PINV-) against a vendor for it, and not an expense (EXP-).
 *
 * The cash ledger still has to know. A crate of water bottles paid for in cash
 * empties the drawer exactly as surely as a plumber does, and a balance that
 * ignores it drifts by the price of every case of stock ever bought. So this
 * reads those purchases back — and the ledger shows them on their own line,
 * never folded in with expenses, because they are not the same kind of thing.
 *
 * Swipe stays the book of record, as with expenses: there is no local copy of
 * a purchase here to drift out of sync.
 */

import { randomUUID } from "node:crypto";
import { swipeRequest } from "../billing/swipe";
import { getPool } from "../pg";
import { appEnvironment, ensureSchema } from "../db/schema";
import { round2 } from "../pricing";
import { fromSwipeDisplayDate, istToday, shiftDays, toSwipeDate } from "../ledger/dates";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * How far before the range to look for purchase invoices, so one raised on the
 * 1st and settled in cash on the 5th still lands on the day the notes left the
 * drawer. Same reasoning as the sales tally: Swipe filters on the document's
 * own date, not its payments'.
 */
const LATE_PAYMENT_LOOKBACK_DAYS = 14;

export interface CashPurchase {
  /** IST day the cash was actually handed over, "YYYY-MM-DD". */
  day: string;
  amountInr: number;
  vendor: string;
  /** The PINV- serial, so a figure on the ledger can be traced to a document. */
  serialNumber: string;
}

function vendorName(row: any): string {
  const c = row?.customer;
  return String(c?.company_name || c?.name || "").trim() || "Unknown vendor";
}

/** Raw purchase documents whose own date falls in the range. */
async function listPurchaseDocs(fromSwipe: string, toSwipe: string): Promise<any[]> {
  const body = await swipeRequest<{ transactions?: any[] }>("v2/doc", "get_transactions", {
    // A month of stock buying is a handful of documents, not hundreds.
    num_records: 250,
    page: 0,
    payment_status: 0,
    search: "",
    search_type: "Customer",
    filters: {
      invoice_type: [],
      payment_mode: "",
      filtered_users: [],
      status: "",
      is_export: false,
      type_of_doc: [],
      prefixes: [],
    },
    date: `${fromSwipe} - ${toSwipe}`,
    document_type: "purchase",
    sort_type: "",
    sort_order: "",
  });
  return body.transactions ?? [];
}

/** Every cash-paid stock purchase whose money moved within [from, to]. */
export async function listCashPurchases(from: string, to: string): Promise<CashPurchase[]> {
  const rows = await listPurchaseDocs(
    toSwipeDate(shiftDays(from, -LATE_PAYMENT_LOOKBACK_DAYS)),
    toSwipeDate(to)
  );

  const out: CashPurchase[] = [];
  for (const row of rows) {
    const payments = Array.isArray(row.payments) ? row.payments : [];
    for (const p of payments) {
      if (String(p.payment_mode ?? "").toLowerCase() !== "cash") continue;

      // Swipe stamps payments DD-MM-YYYY and the document "05 Sep 2026"; fall
      // back to the document's date only when the payment carries none.
      const paid = String(p.payment_date ?? "");
      const m = paid.match(/^(\d{2})-(\d{2})-(\d{4})$/);
      const day = m ? `${m[3]}-${m[2]}-${m[1]}` : fromSwipeDisplayDate(String(row.invoice_date ?? ""));
      if (!day || day < from || day > to) continue;

      out.push({
        day,
        amountInr: Number(p.amount ?? 0),
        vendor: vendorName(row),
        serialNumber: String(row.serial_number ?? ""),
      });
    }
  }
  return out.sort((a, b) => a.day.localeCompare(b.day));
}

// ── Recording stock received ─────────────────────────────────────────────────

export interface Vendor {
  /** Swipe party id. */
  id: number;
  name: string;
}

/**
 * Who we've bought from before.
 *
 * Swipe exposes no endpoint that lists vendor parties — v2/customer's listing
 * actions are for customers, and there is no vendor equivalent — so the list
 * is derived from the purchase invoices themselves. That's no loss in
 * practice: stock comes from the same handful of suppliers every month, and a
 * vendor nobody has ever bought from has nothing to receive against yet.
 *
 * A supplier added through this app has no purchases yet, so it would vanish
 * from the list the moment the sheet was reopened. Those are remembered in our
 * own `vendors` table and unioned in here — see the schema comment for why
 * that isn't a mirror.
 */
export async function listVendors(): Promise<Vendor[]> {
  const today = istToday();
  const [rows, ours] = await Promise.all([
    listPurchaseDocs(toSwipeDate(shiftDays(today, -365)), toSwipeDate(today)),
    listOwnVendors().catch((err) => {
      // Postgres being down shouldn't hide the suppliers Swipe can still name.
      console.error("own vendor list failed:", err);
      return [] as Vendor[];
    }),
  ]);

  const byId = new Map<number, string>();
  for (const v of ours) byId.set(v.id, v.name);
  for (const row of rows) {
    // vendor_id, NOT customer.id. The latter is the party row attached to that
    // one document (a different number on every purchase); vendor_id is the
    // vendor itself, and it's what v3/doc/create's party_ids wants. Passing
    // the other one is refused with "Party not found or deleted".
    const id = Number(row?.customer?.vendor_id ?? 0);
    const name = vendorName(row);
    if (id > 0 && !byId.has(id)) byId.set(id, name);
  }
  return [...byId.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface ReceivedLine {
  productId: number;
  name: string;
  qty: number;
  /** What a unit cost us, tax inclusive. */
  unitCostWithTax: number;
  taxRatePercent: number;
  unit?: string;
}

export interface StockReceivedInput {
  vendorId: number;
  lines: ReceivedLine[];
  /** How it was paid. Cash is the one the ledger cares about. */
  paymentMode: "Cash" | "UPI" | "Card" | "Net Banking" | "Cheque";
  /** False leaves the purchase outstanding against the vendor. */
  paid: boolean;
  /** Who recorded it. Stored on the Swipe notes; see the note in the builder. */
  raisedBy?: string;
}

/** The bank the counter records against (HDFC — bank_id 1 in this account). */
const DEFAULT_BANK_ID = 1;

function purchaseItem(line: ReceivedLine) {
  const unitPrice = round2(line.unitCostWithTax / (1 + line.taxRatePercent / 100));
  const net = round2(unitPrice * line.qty);
  const total = round2(line.unitCostWithTax * line.qty);
  return {
    product_id: line.productId,
    variant_id: 0,
    batch_id: 0,
    product_name: line.name,
    variant_name: "",
    qty: line.qty,
    free_qty: 0,
    conversion_rate: 1,
    unit_price: unitPrice,
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
    item_custom_columns: [],
    purchase_unit_price: unitPrice,
    description: "<p><br></p>",
    unit: line.unit ?? "",
    purchase_update_columns: {},
    price_with_tax: line.unitCostWithTax,
    net_amount: net,
    total_amount: total,
    cess_amount: 0,
    tax_amount: round2(total - net),
  };
}

/**
 * Raise a purchase invoice — stock in, and (when paid in cash) money out of
 * the drawer.
 *
 * This is a PURCHASE, not an expense, and the distinction is the whole reason
 * the flow exists: Swipe increases the product's quantity off the back of this
 * document, and the books treat the money as inventory rather than spend. An
 * expense would do neither.
 *
 * The document mirrors the invoice payload the booking flow already posts to
 * v3/doc/create — same endpoint, same shape — with document_type "purchase"
 * and the party on the vendor side. Payment is recorded separately, as
 * "out" against the vendor, which is what puts it on the cash ledger.
 */
export async function recordStockReceived(
  input: StockReceivedInput
): Promise<{ serialNumber: string }> {
  if (input.lines.length === 0) throw new Error("Nothing to receive");

  const serial = await swipeRequest<{ doc_number?: number; default_prefix?: string }>(
    "utils",
    "get_prefix_seral_number",
    { prefix: "PINV-", document_type: "purchase", suffix: "", is_prefix: true }
  );
  const docNumber = Number(serial.doc_number ?? 0);
  const serialNumber = `${serial.default_prefix ?? "PINV-"}${docNumber}`;

  const items = input.lines.map(purchaseItem);
  const totalAmount = round2(items.reduce((sum, i) => sum + i.total_amount, 0));
  const netAmount = round2(items.reduce((sum, i) => sum + i.net_amount, 0));
  const taxAmount = round2(totalAmount - netAmount);
  const date = toSwipeDate(istToday());

  const res = await swipeRequest<{ doc_count?: number; serial_number?: string }>(
    "v3/doc",
    "create",
    {
      id: -1,
      project_id: -1,
      document_type: "purchase",
      invoice_type: "b2b",
      source: 0,
      doc_number: docNumber,
      suffix: "",
      serial_number: serialNumber,
      document_title: "Purchase",
      doc_without_items: 0,
      party_details: {},
      send_pos_sms: 0,
      party_ids: [input.vendorId],
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
      // With no local copy of a purchase to hang a column on, the person who
      // raised it rides on the notes as a "[by Name]" suffix and is parsed
      // back out when listing. Reads fine inside Swipe's own UI too — exactly
      // what ../staff/expenses.ts does, for the same reason.
      notes: input.raisedBy ? `Stock received via Play Panda ops [by ${input.raisedBy}]` : "Stock received via Play Panda ops",
      reference: "",
      is_draft: false,
      is_pos: false,
      skip_warning: false,
      customer_shipping_addr_id: -1,
      customer_billing_addr_id: -1,
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
      show_description: 1,
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
      is_created_by_recurring: 0,
      sub_serial_number: "",
      convert: { convert_from: "", doc_count: 0 },
      convert_list: [],
      document_custom_additional_charges: [],
      document_item_headers: [],
      attachments: [],
      document_custom_headers: [],
      // Payments are posted separately below; Swipe's own screen sends an
      // empty array here even when it is about to record one.
      payments: [],
      price_list_id: 0,
      waiting_for_approval: false,
      is_shopify: false,
    }
  );

  const created = String(res.serial_number ?? serialNumber);

  if (input.paid) {
    // Recorded separately, and "out" against the vendor — this is what the
    // cash ledger reads back when the mode is Cash.
    await swipeRequest("v3/payments", "create_payment", {
      payments: [
        {
          documents: [
            {
              serial_number: created,
              amount_settled: totalAmount,
              doc_count: Number(res.doc_count ?? 0),
              document_type: "purchase",
            },
          ],
          payment_date: date,
          notes: "",
          utr_id: "",
          party_id: input.vendorId,
          party_type: "vendor",
          amount: totalAmount,
          payment_mode: input.paymentMode,
          bank_id: DEFAULT_BANK_ID,
          payment_type: "out",
          tds_details: { apply_on: "net_amount", is_tds: 0 },
          attachments: [],
          signature: "",
          send_sms: false,
          send_email: false,
        },
      ],
    });
  }

  return { serialNumber: created };
}

// ── Listing and vendors ──────────────────────────────────────────────────────

/** The "[by Name]" suffix recordStockReceived appends to the notes. */
const RAISED_BY_RE = /\s*\[by ([^\][]+)\]\s*$/;

export interface PurchaseRecord {
  serialNumber: string;
  /** As Swipe returns it, e.g. "05 Sep 2026". */
  date: string;
  vendor: string;
  totalInr: number;
  pendingInr: number;
  paymentStatus: string;
  /** Blank when the purchase was left unpaid. */
  paymentModes: string[];
  /** Parsed from the notes; empty for purchases raised in Swipe itself. */
  raisedBy: string;
  /** Swipe's own record of who created the document. */
  createdBy: string;
}

export interface PurchaseMonth {
  purchases: PurchaseRecord[];
  totalInr: number;
  /** What of that total was paid in cash — the part the drawer felt. */
  cashInr: number;
  pendingInr: number;
}

/** A month of stock buying, straight from Swipe. No local copy to drift. */
export async function listPurchases(from: string, to: string): Promise<PurchaseMonth> {
  const rows = await listPurchaseDocs(toSwipeDate(from), toSwipeDate(to));

  const purchases: PurchaseRecord[] = rows.map((row) => {
    const notes = String(row.notes ?? "");
    const by = notes.match(RAISED_BY_RE);
    const payments = Array.isArray(row.payments) ? row.payments : [];
    return {
      serialNumber: String(row.serial_number ?? ""),
      date: String(row.invoice_date ?? ""),
      vendor: vendorName(row),
      totalInr: Number(row.total_amount ?? 0),
      pendingInr: Number(row.amount_pending ?? 0),
      paymentStatus: String(row.payment_status ?? ""),
      paymentModes: [
        ...new Set(payments.map((p: any) => String(p.payment_mode ?? "")).filter(Boolean)),
      ] as string[],
      raisedBy: by ? by[1].trim() : "",
      createdBy: String(row.user_name ?? "").trim(),
    };
  });

  const cashInr = rows.reduce((sum, row) => {
    const payments = Array.isArray(row.payments) ? row.payments : [];
    return (
      sum +
      payments
        .filter((p: any) => String(p.payment_mode ?? "").toLowerCase() === "cash")
        .reduce((s: number, p: any) => s + Number(p.amount ?? 0), 0)
    );
  }, 0);

  return {
    purchases,
    totalInr: purchases.reduce((sum, p) => sum + p.totalInr, 0),
    cashInr,
    pendingInr: purchases.reduce((sum, p) => sum + p.pendingInr, 0),
  };
}

/**
 * Add a vendor.
 *
 * Until this existed a new supplier had to be created in Swipe before anything
 * could be bought from them, which made the first purchase from anyone the one
 * you couldn't record here. `force_add_vendor` skips Swipe's "this looks like
 * an existing party" interstitial, which has no answer over an API.
 */
export async function createVendor(input: {
  name: string;
  phone?: string;
}): Promise<{ id: number }> {
  const body = await swipeRequest<{ vendor_id?: number; id?: number; customer_id?: number }>(
    "v2/vendor",
    "add",
    {
      name: input.name,
      phone: input.phone ? Number(input.phone) : "",
      email: "",
      company_name: "",
      gstin: "",
      billing: { address_1: "", address_2: "", pincode: "", state: "", city: "", country: "India" },
      opening_balance_type: 1,
      opening_balance: 0,
      balance: 0,
      is_tds: false,
      is_tcs: false,
      is_rcm: false,
      tags: [],
      dial_code: "91",
      shipping_address: [],
      linked_customer: -1,
      cc_emails: "",
      custom_values: {},
      custom_fields: {},
      profile_image: "",
      is_ecom: false,
      add_same_customer: false,
      force_add_vendor: true,
      bank_details: [],
      is_existing_vendor_check: 1,
    }
  );
  const id = Number(body.vendor_id ?? body.id ?? body.customer_id ?? 0);
  if (!id) throw new Error("Swipe accepted the vendor but returned no id");

  // Best-effort: Swipe has the vendor either way, and failing the whole call
  // because we couldn't note it locally would be the wrong trade.
  try {
    await rememberVendor(id, input.name);
  } catch (err) {
    console.error("remembering vendor failed:", err);
  }
  return { id };
}

/** Suppliers this app created — the ones purchase history can't yet name. */
async function listOwnVendors(): Promise<Vendor[]> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT swipe_ref, name FROM vendors WHERE environment = $1 ORDER BY name`,
    [appEnvironment()]
  );
  return rows.map((r) => ({ id: Number(r.swipe_ref), name: r.name }));
}

async function rememberVendor(swipeVendorId: number, name: string): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `INSERT INTO vendors (id, environment, swipe_ref, name)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (swipe_ref, environment) DO UPDATE
       SET name = EXCLUDED.name, last_updated_at = now()`,
    [randomUUID(), appEnvironment(), String(swipeVendorId), name]
  );
}

/* eslint-enable @typescript-eslint/no-explicit-any */
