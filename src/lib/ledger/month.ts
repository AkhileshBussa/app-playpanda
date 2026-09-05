/**
 * Assembling one month of the cash ledger.
 *
 * Three sources meet here, and which one is authoritative matters:
 *
 *   declared    what the counter counted. The drawer is physical, so this —
 *               not Swipe — is what the running balance is built from.
 *   tally       what Swipe collected the same day. Never feeds the balance;
 *               it exists only to sit beside the declaration and disagree with
 *               it, which is the whole point of the ledger.
 *   cash spent  expenses raised at /ops/expenses and paid in Cash. That money
 *               physically left the drawer, so it must come off the balance —
 *               otherwise the ledger drifts by every roll of tape ever bought.
 *
 * So: closing = opening + declared cash − cash spent − taken out + put in.
 */

import { billing } from "../billing";
import { listExpenses } from "../staff/expenses";
import {
  daysBetween,
  fromSwipeDisplayDate,
  istToday,
  monthEnd,
  monthEnd as lastOfMonth,
  monthLabel,
  monthStart,
  previousMonth,
  toSwipeDate,
} from "./dates";
import {
  earliestMonth,
  getMonth,
  listDeclarations,
  listEditsByDay,
  listMovements,
  setOpening,
} from "./db";
import type { LedgerDay, LedgerMonth } from "./types";

/** How many months a carried-forward opening may chain back through. */
const MAX_CARRY_MONTHS = 12;

interface Opening {
  openingInr: number;
  isExplicit: boolean;
  setBy: string;
  startsOn: string | null;
}

/**
 * A month's opening balance, carrying forward when nobody has set one.
 *
 * A carried opening is recomputed on every read and cached back to the row, so
 * correcting a day in March still moves April, May and today. An opening a
 * human set is never recomputed — that's what makes it worth setting.
 */
async function resolveOpening(month: string, depth: number): Promise<Opening> {
  const row = await getMonth(month);
  if (row?.isExplicit) {
    return {
      openingInr: row.openingInr,
      isExplicit: true,
      setBy: row.setBy,
      startsOn: row.startsOn,
    };
  }

  const blank: Opening = {
    openingInr: row?.openingInr ?? 0,
    isExplicit: false,
    setBy: "",
    startsOn: row?.startsOn ?? null,
  };

  const earliest = await earliestMonth();
  const prev = previousMonth(month);
  // Nothing before this month means the ledger starts here: there is no close
  // to carry, and the opening stays whatever it is until someone sets it.
  if (!earliest || prev < earliest || depth >= MAX_CARRY_MONTHS) return blank;

  const before = await build(prev, false, depth + 1);
  const carried = before.cashInStoreInr;
  if (!row || row.openingInr !== carried) {
    await setOpening({ month, openingInr: carried, isExplicit: false });
  }
  return { ...blank, openingInr: carried };
}

/** Cash that left the drawer, by day, read straight from Swipe's expenses. */
async function cashSpentByDay(from: string, to: string): Promise<Map<string, number>> {
  const { expenses } = await listExpenses(toSwipeDate(from), toSwipeDate(to));
  const byDay = new Map<string, number>();
  for (const e of expenses) {
    if (e.paymentMode.toLowerCase() !== "cash") continue;
    const day = fromSwipeDisplayDate(e.expenseDate);
    if (!day || day < from || day > to) continue;
    // What actually left the drawer. Expenses raised from /ops are paid in
    // full, but one entered in Swipe as part-paid should only take its paid
    // part off the balance.
    const amount = e.amountPaid > 0 ? e.amountPaid : e.totalAmount;
    byDay.set(day, (byDay.get(day) ?? 0) + amount);
  }
  return byDay;
}

async function build(month: string, includeTally: boolean, depth: number): Promise<LedgerMonth> {
  const opening = await resolveOpening(month, depth);
  const startsOn = opening.startsOn ?? monthStart(month);
  const today = istToday();
  // Never draw days that haven't happened: a row of empty future dates reads
  // as missing paperwork.
  const lastDay = monthEnd(month) < today ? monthEnd(month) : today;
  const dates = lastDay < startsOn ? [] : daysBetween(startsOn, lastDay);

  const [declarations, movements, editsByDay] = await Promise.all([
    dates.length ? listDeclarations(startsOn, lastDay) : Promise.resolve([]),
    dates.length ? listMovements(startsOn, lastDay) : Promise.resolve([]),
    // Deliberately the WHOLE month, not just the days on show: moving the
    // ledger's start date would otherwise orphan the history of the days it
    // used to cover, which is precisely the change worth being able to see.
    listEditsByDay(monthStart(month), lastOfMonth(month)),
  ]);

  // Opening-balance changes are filed against the month's first covered day,
  // but they belong to the month, not to that day's takings — so they're
  // lifted out here and shown against the opening balance itself.
  const openingEdits = [...editsByDay.values()]
    .flat()
    .filter((e) => e.entity === "opening")
    .sort((a, b) => b.at - a.at);

  let expensesError: string | null = null;
  let spent = new Map<string, number>();
  if (dates.length) {
    try {
      spent = await cashSpentByDay(startsOn, lastDay);
    } catch (err) {
      console.error("ledger: cash expenses unavailable:", err);
      expensesError = "Cash expenses couldn't be read from Swipe — the balance below is before them.";
    }
  }

  let tallyError: string | null = null;
  const tallies = new Map<string, { cash: number; card: number; upi: number; other: number }>();
  if (includeTally && dates.length) {
    try {
      for (const c of await billing.getCollectionsByDay(startsOn, lastDay)) {
        tallies.set(c.date, { cash: c.cash, card: c.card, upi: c.upi, other: c.other });
      }
    } catch (err) {
      console.error("ledger: Swipe tally unavailable:", err);
      tallyError = "Couldn't read the Swipe side of the tally.";
    }
  }

  const declaredByDay = new Map(declarations.map((d) => [d.day, d]));
  const totals = {
    declaredCash: 0,
    declaredOnline: 0,
    tallyCash: includeTally && !tallyError ? 0 : null,
    tallyOnline: includeTally && !tallyError ? 0 : null,
    cashSpent: 0,
    cashTakenOut: 0,
    cashPutIn: 0,
  } as LedgerMonth["totals"];

  const missingDays: string[] = [];
  const days: LedgerDay[] = [];
  let balance = opening.openingInr;

  for (const date of dates) {
    const declared = declaredByDay.get(date) ?? null;
    const dayMovements = movements.filter((m) => m.day === date);
    const cashSpent = spent.get(date) ?? 0;

    const takenOut = dayMovements
      .filter((m) => m.direction === "out")
      .reduce((sum, m) => sum + m.amountInr, 0);
    const putIn = dayMovements
      .filter((m) => m.direction === "in")
      .reduce((sum, m) => sum + m.amountInr, 0);

    balance += (declared?.cashInr ?? 0) - cashSpent - takenOut + putIn;

    // Today is still being traded — it isn't "missing", it's not closed yet.
    if (!declared && date < today) missingDays.push(date);

    const raw = tallies.get(date);
    const tally = raw
      ? { ...raw, online: raw.card + raw.upi + raw.other }
      : includeTally && !tallyError
        ? { cash: 0, card: 0, upi: 0, other: 0, online: 0 }
        : null;

    totals.declaredCash += declared?.cashInr ?? 0;
    totals.declaredOnline += declared?.onlineInr ?? 0;
    if (tally && totals.tallyCash !== null && totals.tallyOnline !== null) {
      totals.tallyCash += tally.cash;
      totals.tallyOnline += tally.online;
    }
    totals.cashSpent += cashSpent;
    totals.cashTakenOut += takenOut;
    totals.cashPutIn += putIn;

    days.push({
      date,
      declared,
      tally,
      cashSpentInr: cashSpent,
      movements: dayMovements,
      closingInr: balance,
      edits: (editsByDay.get(date) ?? []).filter((e) => e.entity !== "opening"),
    });
  }

  return {
    month,
    label: monthLabel(month),
    openingInr: opening.openingInr,
    openingIsExplicit: opening.isExplicit,
    openingSetBy: opening.setBy,
    startsOn,
    // Newest first: the day being worked on is the one you came to see.
    days: days.reverse(),
    missingDays,
    openingEdits,
    totals,
    cashInStoreInr: balance,
    tallyError,
    expensesError,
  };
}

/**
 * One month of the ledger.
 *
 * `includeTally` is the owner tier, and it is enforced HERE rather than in the
 * UI: the counter's response never carries the Swipe figures at all, so there
 * is nothing to reveal by poking at the network tab.
 */
export function buildLedgerMonth(month: string, includeTally: boolean): Promise<LedgerMonth> {
  return build(month, includeTally, 0);
}
