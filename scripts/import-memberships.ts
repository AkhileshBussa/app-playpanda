/**
 * One-off import of the "Memberships Tracker" sheet into Postgres.
 *
 *   npx tsx scripts/import-memberships.ts "<csv path>"            # dry run
 *   npx tsx scripts/import-memberships.ts "<csv path>" --commit   # write
 *
 * The sheet is a hand-kept tracker, so parsing is deliberately forgiving and
 * loud: every repair and every row it refuses is printed, and a dry run writes
 * the whole plan to JSON for reading before anything is inserted.
 *
 * Punches are inserted straight into membership_visits rather than through
 * recordVisit(), for two reasons: recordVisit enforces expiry and plays-left
 * (historical rows break both), and it raises a ₹0 invoice in Swipe, which
 * would mean hundreds of new documents for visits that happened months ago.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
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

interface PlanShape {
  planKey: string;
  planName: string;
  punchProductId: number;
  totalPlays: number | null;
  hoursPerPlay: number;
  kidsPerPlay: number;
  validityMonths: number;
  weekdaysOnly: boolean;
  oncePerDay: boolean;
}

const CATALOG_KEYS: Record<string, string> = {
  "fun five pass": "fun-five",
  "fun ten pass": "fun-ten",
  "fun five pass 10 - 1hr": "fun-ten",
  "panda pro 12": "pro-12",
  "panda max 25": "max-25",
  "supervised play pass": "supervised",
};

/**
 * Sheet plans with no product behind them in Swipe. Left out on purpose:
 * a membership has to punch against a real Swipe product, so these want a
 * product created first and then hand entry.
 */
const NO_SWIPE_PRODUCT = new Set([
  "fun five pass 1hr",
  "panda max 50 - 1hr",
  "unlimited(48)",
]);

/** Rows whose phone cell is empty but whose owner is known from the sheet. */
const PHONE_OVERRIDES: Record<number, string> = {
  20: "8979308484",
};

const NON_DATE_MARKERS = ["membership completed", "completed", "/", "-"];

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

interface DateParse {
  date: string | null;
  repaired?: string;
  problem?: string;
}

/** Sheet dates are D/M/YY-ish, with typos. Returns YYYY-MM-DD in IST terms. */
function parseSheetDate(raw: string): DateParse {
  const value = raw.trim().replace(/\s+/g, "");
  if (!value) return { date: null };
  if (NON_DATE_MARKERS.includes(value.toLowerCase())) {
    return { date: null, problem: `marker "${raw.trim()}"` };
  }

  let parts = value.split(/[/-]/).filter(Boolean);

  if (parts.length === 2 && /^\d{4}$/.test(parts[0])) {
    parts = [parts[0].slice(0, 2), parts[0].slice(2), parts[1]];
  }
  if (parts.length === 2 && /^\d{4}$/.test(parts[1])) {
    parts = [parts[0], parts[1].slice(0, 2), parts[1].slice(2)];
  }
  if (parts.length !== 3) return { date: null, problem: `unparseable "${raw.trim()}"` };

  let [d, m, y] = parts.map((p) => parseInt(p, 10));
  if ([d, m, y].some((n) => isNaN(n))) return { date: null, problem: `unparseable "${raw.trim()}"` };

  const year = y < 100 ? 2000 + y : y;
  let repaired: string | undefined;

  if (m === 0 || m > 12) return { date: null, problem: `bad month in "${raw.trim()}"` };
  if (d === 0 || d > 31) {
    const swapped = parseInt(String(d).split("").reverse().join(""), 10);
    if (swapped >= 1 && swapped <= 31) {
      repaired = `day ${d} → ${swapped}`;
      d = swapped;
    } else return { date: null, problem: `bad day in "${raw.trim()}"` };
  }
  const iso = `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const back = new Date(`${iso}T00:00:00Z`);
  if (isNaN(back.getTime()) || back.getUTCDate() !== d) {
    return { date: null, problem: `not a real date "${raw.trim()}"` };
  }
  if (value !== `${parts[0]}/${parts[1]}/${parts[2]}`) {
    repaired = repaired ?? `read "${raw.trim()}" as ${iso}`;
  }
  return { date: iso, repaired };
}

const todayIST = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

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

interface Planned {
  sheetRow: number;
  phone: string;
  customerName: string;
  kidNames: string;
  plan: PlanShape;
  sheetPlan: string;
  startsOn: string;
  expiresOn: string;
  visits: string[];
  notes: string[];
}

async function main() {
  const csvPath = process.argv[2];
  const commit = process.argv.includes("--commit");
  if (!csvPath) throw new Error('Usage: import-memberships.ts "<csv path>" [--commit]');

  const rows = splitCsv(readFileSync(csvPath, "utf8"));
  const planned: Planned[] = [];
  const refused: Array<{ sheetRow: number; who: string; why: string }> = [];
  const repairs: string[] = [];

  const { MEMBERSHIP_PLANS } = await import("../src/lib/members/plans");

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const sheetRow = i + 1;
    if (!row.some((c) => c.trim())) continue;

    const parent = (row[0] ?? "").trim();
    const kidNames = cleanKidNames(row[1] ?? "");
    const phone = ((row[3] ?? "").replace(/\D/g, "") || PHONE_OVERRIDES[sheetRow] || "").slice(-10);
    const sheetPlan = (row[4] ?? "").trim();
    const who = `${parent || kidNames || "?"} (${phone || "no phone"})`;

    if (phone.length !== 10) {
      refused.push({ sheetRow, who, why: "no usable 10-digit phone" });
      continue;
    }
    if (!sheetPlan) {
      refused.push({ sheetRow, who, why: "no plan named" });
      continue;
    }

    const key = sheetPlan.toLowerCase().replace(/\s+/g, " ").trim();
    if (NO_SWIPE_PRODUCT.has(key)) {
      refused.push({ sheetRow, who, why: `"${sheetPlan}" has no product in Swipe — enter by hand` });
      continue;
    }
    let plan: PlanShape | null = null;
    const catalogKey = CATALOG_KEYS[key];
    if (catalogKey) {
      const p = MEMBERSHIP_PLANS.find((x) => x.key === catalogKey)!;
      plan = {
        planKey: p.key,
        planName: p.name,
        punchProductId: p.punchProductId,
        totalPlays: p.totalPlays,
        hoursPerPlay: p.hoursPerPlay,
        kidsPerPlay: p.kidsPerPlay,
        validityMonths: p.validityMonths,
        weekdaysOnly: p.weekdaysOnly,
        oncePerDay: p.oncePerDay,
      };
    }
    if (!plan) {
      refused.push({ sheetRow, who, why: `unknown plan "${sheetPlan}"` });
      continue;
    }

    const notes: string[] = [];
    const visits: string[] = [];
    for (let c = 5; c < row.length; c++) {
      const parsed = parseSheetDate(row[c] ?? "");
      if (parsed.repaired) repairs.push(`row ${sheetRow} ${who}: ${parsed.repaired}`);
      if (parsed.problem) notes.push(`col ${c - 4}: ${parsed.problem}`);
      if (parsed.date) visits.push(parsed.date);
    }

    const dobCell = parseSheetDate(row[2] ?? "");
    const dated = visits.length ? visits.slice().sort()[0] : dobCell.date;
    const startsOn = dated ?? todayIST();
    if (!dated) {
      notes.push("no date anywhere in the sheet — started at the import day");
    }

    planned.push({
      sheetRow,
      phone,
      customerName: parent || kidNames || "Unknown",
      kidNames,
      plan,
      sheetPlan,
      startsOn,
      expiresOn: addMonths(startsOn, plan.validityMonths),
      visits,
      notes,
    });
  }

  const overPlays = planned.filter(
    (p) => p.plan.totalPlays != null && p.visits.length > p.plan.totalPlays
  );
  const beforeStart = planned.flatMap((p) =>
    p.visits.filter((v) => v < p.startsOn).map((v) => `row ${p.sheetRow} ${p.customerName}: ${v} before start ${p.startsOn}`)
  );
  const afterExpiry = planned.flatMap((p) =>
    p.visits.filter((v) => v > p.expiresOn).map((v) => `row ${p.sheetRow} ${p.customerName}: ${v} after expiry ${p.expiresOn}`)
  );

  console.log(`\nParsed ${planned.length} memberships, ${planned.reduce((n, p) => n + p.visits.length, 0)} punches`);
  console.log(`Plans used:`);
  const byPlan = new Map<string, number>();
  for (const p of planned) byPlan.set(`${p.sheetPlan} → ${p.plan.planName}${p.plan.planKey === "custom" ? " (custom)" : ""}`, (byPlan.get(`${p.sheetPlan} → ${p.plan.planName}${p.plan.planKey === "custom" ? " (custom)" : ""}`) ?? 0) + 1);
  for (const [k, n] of [...byPlan].sort()) console.log(`  ${n.toString().padStart(3)} × ${k}`);

  if (repairs.length) {
    console.log(`\nRepaired dates (${repairs.length}):`);
    for (const r of repairs) console.log(`  ${r}`);
  }
  const withNotes = planned.filter((p) => p.notes.length);
  if (withNotes.length) {
    console.log(`\nCells skipped (${withNotes.reduce((n, p) => n + p.notes.length, 0)}):`);
    for (const p of withNotes) console.log(`  row ${p.sheetRow} ${p.customerName}: ${p.notes.join("; ")}`);
  }
  if (overPlays.length) {
    console.log(`\nMore punches than the plan allows (${overPlays.length}):`);
    for (const p of overPlays) {
      console.log(`  row ${p.sheetRow} ${p.customerName}: ${p.visits.length} punches on ${p.plan.planName} (${p.plan.totalPlays} plays)`);
    }
  }
  if (beforeStart.length) {
    console.log(`\nPunches before the start date (${beforeStart.length}):`);
    for (const b of beforeStart) console.log(`  ${b}`);
  }
  if (afterExpiry.length) {
    console.log(`\nPunches after expiry (${afterExpiry.length}):`);
    for (const a of afterExpiry) console.log(`  ${a}`);
  }
  if (refused.length) {
    console.log(`\nRefused rows (${refused.length}):`);
    for (const r of refused) console.log(`  row ${r.sheetRow} ${r.who}: ${r.why}`);
  }

  const dumpPath = "/Users/akhilesh/Downloads/playpanda-import-plan.json";
  writeFileSync(dumpPath, JSON.stringify({ planned, refused, repairs }, null, 2));
  console.log(`\nFull plan written to ${dumpPath}`);

  if (!commit) {
    console.log("\nDry run — nothing written. Re-run with --commit to insert.\n");
    process.exit(0);
  }

  const { createMembership } = await import("../src/lib/members/db");
  const { getPool } = await import("../src/lib/pg");

  let made = 0;
  let punches = 0;
  for (const p of planned) {
    const membership = await createMembership({
      phone: p.phone,
      customerName: p.customerName,
      kidNames: p.kidNames,
      planKey: p.plan.planKey,
      planName: p.plan.planName,
      punchProductId: p.plan.punchProductId,
      punchProductName: `${p.plan.planName} - Punch`,
      totalPlays: p.plan.totalPlays,
      hoursPerPlay: p.plan.hoursPerPlay,
      kidsPerPlay: p.plan.kidsPerPlay,
      priceInr: null,
      saleInvoiceNumber: "",
      paidBy: "",
      paidByRef: "",
      weekdaysOnly: p.plan.weekdaysOnly,
      oncePerDay: p.plan.oncePerDay,
      startsOn: p.startsOn,
      expiresOn: p.expiresOn,
      createdOn: p.startsOn,
      notes: [`Imported from the tracker sheet (row ${p.sheetRow})`, ...p.notes].join(" · "),
    });
    made++;

    for (const date of p.visits) {
      await getPool().query(
        `INSERT INTO membership_visits (
           id, membership_id, kids_count, plays_used, kid_names, visited_at, metadata
         ) VALUES ($1,$2,1,1,$3,($4::date + time '12:00') AT TIME ZONE 'Asia/Kolkata',$5)`,
        [
          randomUUID(),
          membership.id,
          p.kidNames,
          date,
          JSON.stringify({ imported_from: "memberships tracker sheet", sheet_row: p.sheetRow }),
        ]
      );
      punches++;
    }
  }

  console.log(`\nInserted ${made} memberships and ${punches} punches.\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
