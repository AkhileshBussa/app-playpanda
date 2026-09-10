/**
 * Insert memberships from the REVIEWED CSV that prepare-membership-import.ts
 * writes (and a human has checked).
 *
 *   npx tsx scripts/import-memberships.ts "<review csv>"            # dry run
 *   npx tsx scripts/import-memberships.ts "<review csv>" --commit   # write
 *
 * This script deliberately knows nothing about the tracker sheet or Swipe: the
 * reviewed CSV is the source of truth, so a wrong row is fixed in the file
 * rather than in code. Rows whose `import` column isn't "yes" are skipped.
 *
 * Punches go straight into membership_visits rather than through recordVisit():
 * that path enforces expiry and plays-left (historical rows break both) and it
 * raises a ₹0 invoice in Swipe, which would mean hundreds of new documents for
 * visits that happened months ago.
 */
import { readFileSync } from "node:fs";
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

const DATE = /^\d{4}-\d{2}-\d{2}$/;

async function main() {
  const csvPath = process.argv[2];
  const commit = process.argv.includes("--commit");
  if (!csvPath) throw new Error('Usage: import-memberships.ts "<review csv>" [--commit]');

  const rows = splitCsv(readFileSync(csvPath, "utf8"));
  const header = rows[0].map((h) => h.trim());
  const col = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`CSV is missing the "${name}" column`);
    return i;
  };
  const idx = {
    sheetRow: col("sheet_row"),
    parent: col("parent_name"),
    kids: col("kid_names"),
    phone: col("phone"),
    planKey: col("plan_key"),
    createdOn: col("created_on"),
    expiresOn: col("expires_on"),
    punchDates: col("punch_dates"),
    invoice: col("invoice_number"),
    invoiceDate: col("invoice_date"),
    invoiceTotal: col("invoice_total_inr"),
    planAmount: col("plan_amount_inr"),
    paidBy: col("paid_by"),
    paidByRef: col("paid_by_ref"),
    notes: col("notes"),
    import: col("import"),
  };

  const { getPlan } = await import("../src/lib/members/plans");

  interface Ready {
    sheetRow: string;
    phone: string;
    parent: string;
    kids: string;
    planKey: string;
    createdOn: string;
    expiresOn: string;
    visits: string[];
    invoice: string;
    invoiceDate: string;
    invoiceTotal: number | null;
    priceInr: number | null;
    paidBy: string;
    paidByRef: string;
    notes: string;
  }

  const ready: Ready[] = [];
  const skipped: string[] = [];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r.some((c) => c.trim())) continue;
    const sheetRow = r[idx.sheetRow]?.trim() || String(i + 1);
    const who = `${r[idx.parent] || "?"} (${r[idx.phone] || "no phone"})`;

    if ((r[idx.import] ?? "").trim().toLowerCase() !== "yes") {
      skipped.push(`row ${sheetRow} ${who}: import="${(r[idx.import] ?? "").trim()}"`);
      continue;
    }
    const phone = (r[idx.phone] ?? "").replace(/\D/g, "");
    const planKey = (r[idx.planKey] ?? "").trim();
    const plan = getPlan(planKey);
    if (phone.length !== 10) {
      skipped.push(`row ${sheetRow} ${who}: phone isn't 10 digits`);
      continue;
    }
    if (!plan) {
      skipped.push(`row ${sheetRow} ${who}: plan_key "${planKey}" isn't in the catalogue`);
      continue;
    }
    const createdOn = (r[idx.createdOn] ?? "").trim();
    const expiresOn = (r[idx.expiresOn] ?? "").trim();
    if (!DATE.test(createdOn) || !DATE.test(expiresOn)) {
      skipped.push(`row ${sheetRow} ${who}: created_on/expires_on must be YYYY-MM-DD`);
      continue;
    }
    const visits = (r[idx.punchDates] ?? "")
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean);
    const badDate = visits.find((d) => !DATE.test(d));
    if (badDate) {
      skipped.push(`row ${sheetRow} ${who}: punch date "${badDate}" isn't YYYY-MM-DD`);
      continue;
    }
    if (plan.totalPlays != null && visits.length > plan.totalPlays) {
      skipped.push(
        `row ${sheetRow} ${who}: ${visits.length} punches on a ${plan.totalPlays}-play plan`
      );
      continue;
    }

    const planAmount = (r[idx.planAmount] ?? "").trim();
    const invoiceTotal = (r[idx.invoiceTotal] ?? "").trim();
    ready.push({
      sheetRow,
      phone,
      parent: (r[idx.parent] ?? "").trim() || (r[idx.kids] ?? "").trim() || "Unknown",
      kids: (r[idx.kids] ?? "").trim(),
      planKey,
      createdOn,
      expiresOn,
      visits,
      invoice: (r[idx.invoice] ?? "").trim(),
      invoiceDate: (r[idx.invoiceDate] ?? "").trim(),
      invoiceTotal: invoiceTotal ? Number(invoiceTotal) : null,
      priceInr: planAmount ? Number(planAmount) : null,
      paidBy: (r[idx.paidBy] ?? "").trim(),
      paidByRef: (r[idx.paidByRef] ?? "").trim(),
      notes: (r[idx.notes] ?? "").trim(),
    });
  }

  console.log(`\nReady to insert: ${ready.length} memberships, ${ready.reduce((n, r) => n + r.visits.length, 0)} punches`);
  console.log(`  with a sale invoice: ${ready.filter((r) => r.invoice).length}`);
  console.log(`  with paid_by: ${ready.filter((r) => r.paidBy).length}`);
  console.log(`  with a price: ${ready.filter((r) => r.priceInr != null).length}`);
  if (skipped.length) {
    console.log(`\nSkipped (${skipped.length}):`);
    for (const s of skipped) console.log(`  ${s}`);
  }

  if (!commit) {
    console.log("\nDry run — nothing written. Re-run with --commit to insert.\n");
    process.exit(0);
  }

  const { createMembership } = await import("../src/lib/members/db");
  const { getPool } = await import("../src/lib/pg");

  let made = 0;
  let punches = 0;
  for (const r of ready) {
    const plan = getPlan(r.planKey)!;
    const membership = await createMembership({
      phone: r.phone,
      customerName: r.parent,
      kidNames: r.kids,
      planKey: plan.key,
      planName: plan.name,
      punchProductId: plan.punchProductId,
      punchProductName: plan.punchProductName,
      punchTaxRatePercent: plan.taxRatePercent,
      totalPlays: plan.totalPlays,
      hoursPerPlay: plan.hoursPerPlay,
      kidsPerPlay: plan.kidsPerPlay,
      priceInr: r.priceInr,
      saleInvoiceNumber: r.invoice,
      sale: r.invoice
        ? {
            totalInr: r.invoiceTotal,
            issuedAt: DATE.test(r.invoiceDate)
              ? new Date(`${r.invoiceDate}T12:00:00+05:30`).getTime()
              : null,
          }
        : null,
      paidBy: r.paidBy,
      paidByRef: r.paidByRef,
      weekdaysOnly: plan.weekdaysOnly,
      oncePerDay: plan.oncePerDay,
      startsOn: r.createdOn,
      expiresOn: r.expiresOn,
      createdOn: r.createdOn,
      notes: [`Imported from the tracker sheet (row ${r.sheetRow})`, r.notes].filter(Boolean).join(" · "),
    });
    made++;

    for (const date of r.visits) {
      await getPool().query(
        `INSERT INTO membership_visits (
           id, membership_id, kids_count, plays_used, kid_names, visited_at, metadata
         ) VALUES ($1,$2,1,1,$3,($4::date + time '12:00') AT TIME ZONE 'Asia/Kolkata',$5)`,
        [
          randomUUID(),
          membership.id,
          r.kids,
          date,
          JSON.stringify({ imported_from: "memberships tracker sheet", sheet_row: r.sheetRow }),
        ]
      );
      punches++;
    }
    if (made % 10 === 0) console.log(`  …${made} memberships`);
  }

  console.log(`\nInserted ${made} memberships and ${punches} punches.\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
