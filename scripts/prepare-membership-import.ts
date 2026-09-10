/**
 * Turn the hand-kept "Memberships Tracker" sheet into one reviewable CSV,
 * with each membership's real sale invoice and payment pulled from Swipe.
 *
 *   npx tsx scripts/prepare-membership-import.ts "<tracker csv>" [out.csv]
 *
 * Reads only — Swipe and Postgres are both left untouched. The output is the
 * file a human checks, and then `import-memberships.ts` inserts from it, so
 * anything wrong can be fixed in the CSV rather than in this script.
 *
 * Invoice matching works off what Swipe actually recorded, not off dates or
 * prices: every invoice on the phone is opened, and the ones carrying a line
 * in the "Play Time - Memberships" category ARE that customer's membership
 * sales. Guessing by date missed a sale billed a fortnight after the first
 * punch; guessing by price missed one sold at ₹1999 instead of ₹2499.
 *
 * Those sales are then handed to the phone's sheet rows, best match first
 * (same plan name, nearest date), never reusing one invoice twice — a family
 * that bought three passes has three invoices to hand out. The invoice's own
 * date becomes the purchase date, and its membership line the price, so a
 * bill that also carried socks doesn't inflate what the membership records.
 * `match` says how each row was resolved, and anything unresolved is left
 * blank rather than guessed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

try {
  const envFile = readFileSync(resolve(__dirname, "../.env.local"), "utf8");
  for (const line of envFile.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
} catch {
  // Rely on the shell environment.
}

const CATALOG_KEYS: Record<string, string> = {
  "fun five pass": "fun-five",
  "fun ten pass": "fun-ten",
  "fun five pass 10 - 1hr": "fun-ten",
  "panda pro 12": "pro-12",
  "panda max 25": "max-25",
  "supervised play pass": "supervised",
};

const NO_SWIPE_PRODUCT = new Set(["fun five pass 1hr", "panda max 50 - 1hr", "unlimited(48)"]);

const PHONE_OVERRIDES: Record<number, string> = { 20: "8979308484" };

const NON_DATE_MARKERS = ["membership completed", "completed", "/", "-"];

const MEMBERSHIP_CATEGORY = "play time - memberships";

function splitCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function parseSheetDate(raw: string): { date: string | null; problem?: string } {
  const value = raw.trim().replace(/\s+/g, "");
  if (!value) return { date: null };
  if (NON_DATE_MARKERS.includes(value.toLowerCase())) return { date: null, problem: `marker "${raw.trim()}"` };

  let parts = value.split(/[/-]/).filter(Boolean);
  if (parts.length === 2 && /^\d{4}$/.test(parts[0])) parts = [parts[0].slice(0, 2), parts[0].slice(2), parts[1]];
  if (parts.length === 2 && /^\d{4}$/.test(parts[1])) parts = [parts[0], parts[1].slice(0, 2), parts[1].slice(2)];
  if (parts.length !== 3) return { date: null, problem: `unparseable "${raw.trim()}"` };

  let [d, m, y] = parts.map((p) => parseInt(p, 10));
  if ([d, m, y].some((n) => isNaN(n))) return { date: null, problem: `unparseable "${raw.trim()}"` };
  const year = y < 100 ? 2000 + y : y;
  if (m === 0 || m > 12) return { date: null, problem: `bad month in "${raw.trim()}"` };
  if (d === 0 || d > 31) {
    const swapped = parseInt(String(d).split("").reverse().join(""), 10);
    if (swapped >= 1 && swapped <= 31) d = swapped;
    else return { date: null, problem: `bad day in "${raw.trim()}"` };
  }
  const iso = `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const back = new Date(`${iso}T00:00:00Z`);
  if (isNaN(back.getTime()) || back.getUTCDate() !== d) return { date: null, problem: `not a real date "${raw.trim()}"` };
  return { date: iso };
}

const todayIST = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date());

function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const idx = m - 1 + months;
  const lastDay = new Date(Date.UTC(y, idx + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, idx, Math.min(d, lastDay))).toISOString().slice(0, 10);
}

function cleanKidNames(raw: string): string {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && !/^\d*\s*hrs?$/i.test(s))
    .join(", ");
}

/** "22 Aug 2026" → "2026-08-22". */
function swipeDateToIso(display: string): string | null {
  const m = display.trim().match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/);
  if (!m) return null;
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const idx = months.indexOf(m[2].slice(0, 3).toLowerCase());
  if (idx < 0) return null;
  return `${m[3]}-${String(idx + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

interface SwipeInvoice {
  serial: string;
  hashId: string;
  isoDate: string | null;
  total: number;
  payments: Array<{ mode: string; amount: number }>;
}

interface MembershipSale extends SwipeInvoice {
  lineName: string;
  /** The membership line's total for ALL of its quantity. */
  lineAmount: number;
  /** Passes sold on this invoice — two kids on one bill is quantity 2. */
  quantity: number;
  claimedBy: number[];
}

/** "Fun Ten Pass - 1hr" and "Fun Ten Pass" are the same product to us. */
const normalizeProduct = (name: string) =>
  name.toLowerCase().replace(/\s*-\s*punch\b/g, "").replace(/\s*-?\s*\d+\s*hrs?\b/g, "").replace(/\s+/g, " ").trim();

/** A play count the sheet's own plan name claims, e.g. "Panda Max 50" → 50. */
const playsInName = (name: string) => {
  const m = name.replace(/\d+\s*hrs?/gi, "").match(/\b(\d{2,3})\b/);
  return m ? Number(m[1]) : null;
};

const dayGap = (a: string, b: string) =>
  Math.abs(new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / 86400000;

async function main() {
  const csvPath = process.argv[2];
  const outPath = process.argv[3] ?? "/Users/akhilesh/Downloads/playpanda-import-review.csv";
  if (!csvPath) throw new Error('Usage: prepare-membership-import.ts "<tracker csv>" [out.csv]');

  const { MEMBERSHIP_PLANS } = await import("../src/lib/members/plans");
  const { swipeRequest } = await import("../src/lib/billing/swipe");

  const rows = splitCsv(readFileSync(csvPath, "utf8"));
  const out: string[][] = [];
  const header = [
    "sheet_row", "parent_name", "kid_names", "phone", "sheet_plan", "plan_key", "plan_name",
    "total_plays", "hours_per_play", "validity_months", "created_on", "expires_on",
    "punch_count", "punch_dates", "invoice_number", "invoice_date", "invoice_total_inr",
    "plan_amount_inr", "paid_by", "paid_by_ref", "match", "notes", "import",
  ];

  const invoicesByPhone = new Map<string, SwipeInvoice[]>();

  async function invoicesFor(phone: string): Promise<SwipeInvoice[]> {
    const cached = invoicesByPhone.get(phone);
    if (cached) return cached;
    const res = await swipeRequest<{ transactions?: Array<Record<string, unknown>> }>(
      "v2/doc",
      "get_transactions",
      {
        num_records: 100, page: 0, payment_status: 0,
        search: phone, search_type: "Customer",
        filters: { invoice_type: [], payment_mode: "", filtered_users: [], status: "", is_export: false, type_of_doc: [], prefixes: [] },
        date: "01-01-2026 - 31-12-2026",
        document_type: "invoice", sort_type: "", sort_order: "",
      }
    ).catch((err) => {
      console.error(`  swipe lookup failed for ${phone}: ${err.message}`);
      return {} as { transactions?: Array<Record<string, unknown>> };
    });
    const list: SwipeInvoice[] = (res.transactions ?? []).map((r) => ({
      serial: String(r.serial_number ?? ""),
      hashId: String(r.new_hash_id ?? ""),
      isoDate: swipeDateToIso(String(r.invoice_date ?? "")),
      total: Number(r.total_amount ?? 0),
      payments: (Array.isArray(r.payments) ? (r.payments as Array<Record<string, unknown>>) : []).map((p) => ({
        mode: String(p.payment_mode ?? ""),
        amount: Number(p.amount ?? 0),
      })),
    }));
    invoicesByPhone.set(phone, list);
    return list;
  }

  async function membershipLineOn(
    hashId: string
  ): Promise<{ name: string; amount: number; quantity: number } | null> {
    const d = await swipeRequest<{ invoice_details?: Record<string, unknown> }>(
      "v2/doc",
      "get_invoice",
      { new_hash_id: hashId, document_type: "invoice", is_pdf: false }
    ).catch(() => ({} as { invoice_details?: Record<string, unknown> }));
    const items = (d.invoice_details?.items as Array<Record<string, unknown>>) ?? [];
    let amount = 0;
    let quantity = 0;
    const names: string[] = [];
    for (const item of items) {
      const category = String(item.category ?? item.product_category ?? "").toLowerCase().trim();
      if (category !== MEMBERSHIP_CATEGORY) continue;
      const qty = Number(item.quantity ?? item.qty ?? 1) || 1;
      quantity += qty;
      amount += item.total_amount != null ? Number(item.total_amount) : qty * Number(item.price_with_tax ?? 0);
      names.push(String(item.name ?? item.product_name ?? "").trim());
    }
    return names.length ? { name: [...new Set(names)].join(" + "), amount, quantity: quantity || 1 } : null;
  }

  const salesByPhone = new Map<string, MembershipSale[]>();

  /** Every membership sale Swipe holds for this phone, oldest first. */
  async function salesFor(phone: string): Promise<MembershipSale[]> {
    const cached = salesByPhone.get(phone);
    if (cached) return cached;
    const paid = (await invoicesFor(phone)).filter((inv) => inv.total > 0);
    const sales: MembershipSale[] = [];
    for (const inv of paid) {
      const line = await membershipLineOn(inv.hashId);
      if (line && line.amount > 0) {
        sales.push({ ...inv, lineName: line.name, lineAmount: line.amount, quantity: line.quantity, claimedBy: [] });
      }
    }
    sales.sort((a, b) => (a.isoDate ?? "").localeCompare(b.isoDate ?? ""));
    salesByPhone.set(phone, sales);
    return sales;
  }

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const sheetRow = i + 1;
    if (!row.some((c) => c.trim())) continue;

    const parent = (row[0] ?? "").trim();
    const kidNames = cleanKidNames(row[1] ?? "");
    const phone = ((row[3] ?? "").replace(/\D/g, "") || PHONE_OVERRIDES[sheetRow] || "").slice(-10);
    const sheetPlan = (row[4] ?? "").trim();
    const notes: string[] = [];

    const key = sheetPlan.toLowerCase().replace(/\s+/g, " ").trim();
    const catalogKey = CATALOG_KEYS[key];
    let plan = catalogKey ? MEMBERSHIP_PLANS.find((p) => p.key === catalogKey) ?? null : null;

    const visits: string[] = [];
    for (let c = 5; c < row.length; c++) {
      const parsed = parseSheetDate(row[c] ?? "");
      if (parsed.problem) notes.push(`col ${c - 4}: ${parsed.problem}`);
      if (parsed.date) visits.push(parsed.date);
    }
    visits.sort();

    const dobCell = parseSheetDate(row[2] ?? "");
    const dated = visits.length ? visits[0] : dobCell.date;

    let match = "";
    let importable = "yes";
    if (phone.length !== 10) {
      match = "no phone in the sheet";
      importable = "no";
    } else if (!sheetPlan) {
      match = "no plan in the sheet";
      importable = "no";
    } else if (NO_SWIPE_PRODUCT.has(key)) {
      match = "plan has no product in Swipe";
      importable = "no";
    } else if (!plan) {
      match = `unknown plan "${sheetPlan}"`;
      importable = "no";
    }

    let invoice: MembershipSale | null = null;
    let planAmount: number | null = null;
    if (phone.length === 10) {
      const sales = await salesFor(phone);
      const free = sales.filter((sale) => sale.claimedBy.length < sale.quantity);
      if (free.length) {
        const wanted = normalizeProduct(plan?.name ?? sheetPlan);
        const scored = free.map((sale) => {
          const billed = normalizeProduct(sale.lineName);
          const sameProduct = billed === wanted || billed.includes(wanted) || wanted.includes(billed);
          const gap = dated && sale.isoDate ? dayGap(dated, sale.isoDate) : 400;
          return { sale, score: (sameProduct ? 0 : 1000) + gap, sameProduct, gap };
        });
        scored.sort((a, b) => a.score - b.score);
        const best = scored[0];
        invoice = best.sale;
        invoice.claimedBy.push(sheetRow);
        planAmount = Math.round((invoice.lineAmount / invoice.quantity) * 100) / 100;

        match = best.sameProduct
          ? `${invoice.serial} — ${invoice.lineName}`
          : `${invoice.serial} bills "${invoice.lineName}", sheet says "${sheetPlan}"`;
        if (invoice.quantity > 1) {
          notes.push(`${invoice.serial} covers ${invoice.quantity} passes — this row takes one`);
        }
        if (!best.sameProduct) notes.push("the invoice names a different plan than the sheet");
        if (best.gap > 3 && dated) notes.push(`sheet's first punch is ${dated}, the sale is ${invoice.isoDate}`);
        if (plan && Math.abs(invoice.lineAmount - plan.priceWithTax) > 1) {
          notes.push(`sold at ₹${invoice.lineAmount}, catalogue is ₹${plan.priceWithTax}`);
        }
      } else {
        match = sales.length
          ? `no membership sale left on this number (${sales.length} already matched to other rows)`
          : "no membership sale in Swipe for this number";
      }
    }

    // The sheet's plan names are informal, so where it named something with no
    // product behind it, the invoice's own line decides what was sold.
    if (invoice && (!plan || NO_SWIPE_PRODUCT.has(key))) {
      const billedName = normalizeProduct(invoice.lineName);
      const billed = MEMBERSHIP_PLANS.find((p) => normalizeProduct(p.name) === billedName) ?? null;
      const sheetClaims = playsInName(sheetPlan);
      const contradicts = billed && sheetClaims != null && billed.totalPlays !== sheetClaims;
      if (billed && !contradicts) {
        plan = billed;
        importable = "yes";
        match = `${invoice.serial} bills ${invoice.lineName}`;
        notes.push(`plan taken from the invoice — the sheet said "${sheetPlan}"`);
      } else if (billed && contradicts) {
        match = `${invoice.serial} bills ${invoice.lineName}, sheet claims ${sheetClaims} plays`;
        notes.push("the sheet and the invoice disagree on the plan — decide before importing");
      }
    }

    // The invoice is when they actually bought it; the sheet's punch dates are
    // hand-written and sometimes run earlier.
    const createdOn = invoice?.isoDate ?? dated ?? todayIST();
    if (!invoice && !dated) notes.push("no date in the sheet or Swipe — start left at the export day");
    if (invoice && dated && visits.some((v) => v < createdOn)) {
      notes.push("some punches are dated before the sale");
    }

    const modes = [...new Set((invoice?.payments ?? []).map((p) => p.mode).filter(Boolean))];
    const paidBy = modes.length === 1 ? modes[0] : "";
    if (invoice && modes.length > 1) notes.push(`payments split across ${modes.join(" + ")}`);
    if (invoice && !modes.length) notes.push(`${invoice.serial} has no payment recorded in Swipe`);

    if (plan && plan.totalPlays != null && visits.length > plan.totalPlays) {
      notes.push(`${visits.length} punches on a ${plan.totalPlays}-play plan`);
      importable = "no";
    }

    out.push([
      String(sheetRow),
      parent || kidNames || "Unknown",
      kidNames,
      phone,
      sheetPlan,
      plan?.key ?? "",
      plan?.name ?? "",
      plan ? String(plan.totalPlays ?? "") : "",
      plan ? String(plan.hoursPerPlay) : "",
      plan ? String(plan.validityMonths) : "",
      createdOn,
      plan ? addMonths(createdOn, plan.validityMonths) : "",
      String(visits.length),
      visits.join(";"),
      invoice?.serial ?? "",
      invoice?.isoDate ?? "",
      invoice ? String(invoice.total) : "",
      planAmount == null ? "" : String(planAmount),
      paidBy,
      "",
      match,
      notes.join(" · "),
      importable,
    ].map(String));

    if (sheetRow % 10 === 0) console.error(`  …row ${sheetRow}`);
  }

  writeFileSync(outPath, [header, ...out].map((r) => r.map(csvCell).join(",")).join("\n") + "\n");

  const withInvoice = out.filter((r) => r[14]).length;
  const withPaidBy = out.filter((r) => r[18]).length;
  const importable = out.filter((r) => r[22] === "yes").length;
  console.log(`\nWrote ${out.length} rows to ${outPath}`);
  console.log(`  importable: ${importable}`);
  console.log(`  invoice found: ${withInvoice}`);
  console.log(`  paid_by resolved: ${withPaidBy}`);
  console.log(`  punches: ${out.reduce((n, r) => n + Number(r[12]), 0)}\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
