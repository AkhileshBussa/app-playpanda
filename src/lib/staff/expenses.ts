/**
 * Swipe EXPENSES adapter.
 *
 * Purchases for the playzone used to be typed straight into Swipe. They're now
 * raised from /ops/expenses, but they still land in exactly the same place —
 * Swipe stays the book of record, so nothing about accounting or reporting
 * changes. There is deliberately no local expenses table to drift out of sync.
 *
 * Endpoints (app.getswipe.in, company 2430519):
 *   POST v3/expenses/create      — raise one, returns the EXP- serial
 *   POST expenses/get            — list a date range (transactions[])
 *   POST expenses/get_categories — the category picker
 *   POST expenses/add_category   — new category from the form
 */

import { swipeRequest } from "../billing/swipe";

/** The bank the counter records against (HDFC — bank_id 1 in this account). */
const DEFAULT_BANK_ID = 1;
/** `source` on the create payload; 6 is what the Swipe web app sends. */
const SOURCE_WEB = 6;

export const PAYMENT_MODES = ["UPI", "Cash", "Card", "Net Banking", "Cheque"] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

export interface ExpenseCategory {
  categoryId: number;
  category: string;
}

export interface ExpenseRecord {
  id: number;
  serialNumber: string;
  /** As Swipe returns it, e.g. "07 Aug 2026". */
  expenseDate: string;
  category: string;
  categoryId: number;
  description: string;
  totalAmount: number;
  amountPaid: number;
  amountPending: number;
  paymentStatus: string;
  paymentMode: string;
  bankName: string;
  createdByName: string;
  attachmentCount: number;
}

export interface ExpenseMonth {
  expenses: ExpenseRecord[];
  /** Swipe's own total for the range, so our sum can't disagree with the books. */
  total: number;
  totalPaid: number;
  totalPending: number;
  categories: ExpenseCategory[];
}

/** DD-MM-YYYY in IST — the format Swipe expects on expense payloads. */
export function swipeDate(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")}-${get("month")}-${get("year")}`;
}

/** First and last day of the IST month containing `d`, as Swipe dates. */
export function monthRange(d = new Date()): { from: string; to: string; label: string } {
  const ist = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (type: string) => Number(ist.find((p) => p.type === type)?.value ?? 0);
  const year = get("year");
  const month = get("month");
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  const label = new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-IN", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  return { from: `01-${pad(month)}-${year}`, to: `${lastDay}-${pad(month)}-${year}`, label };
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Swipe category names carry stray whitespace, and an expense raised without
 *  one comes back blank with category_id -1. Normalise here so every screen
 *  agrees on what to call it. */
function categoryName(raw: unknown): string {
  return String(raw ?? "").trim() || "Uncategorised";
}

function toExpense(r: any): ExpenseRecord {
  return {
    id: Number(r.id),
    serialNumber: String(r.serial_number ?? ""),
    expenseDate: String(r.expense_date ?? ""),
    category: categoryName(r.category),
    categoryId: Number(r.category_id ?? 0),
    description: String(r.description ?? ""),
    totalAmount: Number(r.total_amount ?? r.net_amount ?? 0),
    amountPaid: Number(r.amount_paid ?? 0),
    amountPending: Number(r.amount_pending ?? 0),
    paymentStatus: String(r.payment_status ?? ""),
    // Swipe leaves payment_mode blank on the parent and keeps it on the payment.
    paymentMode: String(r.payment_mode || r.payments?.[0]?.payment_mode || ""),
    bankName: String(r.bank_name ?? ""),
    createdByName: String(r.name ?? "").trim(),
    attachmentCount: Array.isArray(r.attachments) ? r.attachments.length : 0,
  };
}

function toCategory(r: any): ExpenseCategory {
  return { categoryId: Number(r.category_id), category: categoryName(r.category) };
}

export async function listExpenses(from: string, to: string): Promise<ExpenseMonth> {
  const body = await swipeRequest<{
    transactions?: any[];
    transactions_total?: number;
    amount_paid?: number;
    amount_pending?: number;
    categories?: any[];
  }>("expenses", "get", {
    document_type: "expense",
    // One page wide enough for a month of playzone purchases; the counter
    // raises a handful a day, not hundreds.
    num_records: 500,
    page: 0,
    search: "",
    search_type: "Serial No.",
    date: `${from} - ${to}`,
    payment_status: "",
    sort_order: "",
    sort_type: "",
    category: "",
    filters: { date_sorting_order: "", date_sorting_type: "", approval_status: "" },
    project_id: [],
  });

  return {
    expenses: (body.transactions ?? []).map(toExpense),
    total: Number(body.transactions_total ?? 0),
    totalPaid: Number(body.amount_paid ?? 0),
    totalPending: Number(body.amount_pending ?? 0),
    categories: (body.categories ?? []).map(toCategory),
  };
}

export async function listExpenseCategories(): Promise<ExpenseCategory[]> {
  const body = await swipeRequest<{ categories?: any[] }>("expenses", "get_categories", {
    type: "expense",
  });
  return (body.categories ?? []).map(toCategory);
}

export async function addExpenseCategory(category: string): Promise<ExpenseCategory> {
  const body = await swipeRequest<{ category?: string; category_id?: number }>(
    "expenses",
    "add_category",
    { category, type: "expense" }
  );
  return { categoryId: Number(body.category_id), category: String(body.category ?? category) };
}

export interface CreateExpenseInput {
  amount: number;
  categoryId: number;
  category: string;
  description: string;
  paymentMode: PaymentMode;
  /** IST day the money went out, DD-MM-YYYY. Defaults to today. */
  expenseDate?: string;
  /** Public URLs of bill photos to attach to the Swipe record. */
  attachments?: string[];
}

export interface CreateExpenseResult {
  serialNumber: string;
  id: number | null;
}

/**
 * Raise an expense in Swipe. Mirrors the payload the Swipe web app's expense
 * form sends: a single-line "items" stub (the form always sends one, even for
 * a category-only expense) and the payment recorded as already paid, which is
 * how a counter purchase actually works.
 */
export async function createExpense(input: CreateExpenseInput): Promise<CreateExpenseResult> {
  const date = input.expenseDate ?? swipeDate(new Date());
  const body = await swipeRequest<{ serial_number?: string; id?: number; doc_count?: number }>(
    "v3/expenses",
    "create",
    {
      total_amount: input.amount,
      expense_date: date,
      category: input.category,
      description: input.description,
      payment_date: date,
      payment_mode: input.paymentMode,
      bank_id: DEFAULT_BANK_ID,
      category_id: input.categoryId,
      is_paid: true,
      attachments: input.attachments ?? [],
      document_type: "expense",
      items: [
        {
          id: `new${Math.random()}`,
          description: "",
          category: "",
          tax: 0,
          tax_amount: 0,
          net_amount: 0,
          total_amount: 0,
          category_id: 0,
        },
      ],
      with_tax: false,
      is_tds: 0,
      tds_details: {},
      amount_type: "total_amount",
      party_type: "vendor",
      party_id: "",
      supplier_invoice_date: "",
      net_amount: input.amount,
      tax_amount: 0,
      project_id: -1,
      roundoff: false,
      roundoff_value: 0,
      source: SOURCE_WEB,
    }
  );

  return {
    serialNumber: String(body.serial_number ?? ""),
    id: body.id == null ? null : Number(body.id),
  };
}

/* eslint-enable @typescript-eslint/no-explicit-any */
