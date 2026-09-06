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

import { swipeRequest } from "../billing/swipe";
import { fromSwipeDisplayDate, shiftDays, toSwipeDate } from "../ledger/dates";

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

/** Every cash-paid stock purchase whose money moved within [from, to]. */
export async function listCashPurchases(from: string, to: string): Promise<CashPurchase[]> {
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
    date: `${toSwipeDate(shiftDays(from, -LATE_PAYMENT_LOOKBACK_DAYS))} - ${toSwipeDate(to)}`,
    document_type: "purchase",
    sort_type: "",
    sort_order: "",
  });

  const out: CashPurchase[] = [];
  for (const row of body.transactions ?? []) {
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

/* eslint-enable @typescript-eslint/no-explicit-any */
