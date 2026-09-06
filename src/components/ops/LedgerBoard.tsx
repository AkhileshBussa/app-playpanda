"use client";

import { useCallback, useEffect, useState } from "react";
import type { CashMovement, LedgerDay, LedgerEdit, LedgerMonth } from "@/lib/ledger/types";

const rupees = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

/** The month the cash ledger was switched on — nothing before it to show. */
const EARLIEST_MONTH = "2026-09";

function istToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Explicitly zoned, so a server render and the browser agree on the month. */
function currentMonth(): string {
  return istToday().slice(0, 7);
}

function monthOptions(): string[] {
  const [year, month] = currentMonth().split("-").map(Number);
  const out: string[] = [];
  for (let back = 0; back < 240; back++) {
    const d = new Date(Date.UTC(year, month - 1 - back, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    if (key < EARLIEST_MONTH) break;
    out.push(key);
  }
  return out;
}

function monthLabel(key: string): string {
  return new Date(`${key}-15T00:00:00Z`).toLocaleDateString("en-IN", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** "Sat 6 Sep" — enough to find a day, short enough to sit on one line. */
function dayLabel(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/**
 * The cash ledger.
 *
 * Two audiences, one screen. The counter declares the day and logs cash the
 * owner takes out, and sees the running balance — they can't reconcile a
 * drawer against a number they aren't shown. The owner sees all that plus what
 * Swipe says the same day collected, side by side, which is the only reason
 * the declaration is asked for separately at all.
 *
 * The tally columns are absent from the counter's data, not hidden from it:
 * the server never sends them (see lib/ledger/month.ts).
 */
export default function LedgerBoard({ isAdmin }: { isAdmin: boolean }) {
  const [month, setMonth] = useState(currentMonth());
  const [data, setData] = useState<LedgerMonth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [declaring, setDeclaring] = useState<string | null>(null);
  const [movingCash, setMovingCash] = useState(false);
  const [editingOpening, setEditingOpening] = useState(false);
  // Who's at the counter. Same stand-in for per-person login the expenses form
  // uses: a shared password can't say who you are, so the form asks.
  const [staff, setStaff] = useState<string[]>([]);

  useEffect(() => {
    fetch("/api/ops/employees")
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        const names = (body?.employees ?? [])
          .filter((e: { active: boolean }) => e.active)
          .map((e: { name: string }) => e.name);
        setStaff(names);
      })
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/ops/ledger?month=${month}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Couldn't load");
      setData(body.ledger);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load");
    } finally {
      setLoading(false);
    }
  }, [month]);

  useEffect(() => {
    load();
  }, [load]);

  async function removeMovement(id: string) {
    await fetch(`/api/ops/ledger/movement?id=${id}`, { method: "DELETE" });
    load();
  }

  const today = istToday();
  const todayDeclared = Boolean(data?.days.find((d) => d.date === today)?.declared);

  return (
    <div className="mx-auto w-full max-w-3xl px-3 pb-24">
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="relative">
          <select
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            aria-label="Month"
            className="w-full cursor-pointer appearance-none rounded-full bg-white py-2 pl-4 pr-10 text-sm font-black text-ink shadow-btn outline-none transition-all hover:bg-ink/5 focus-visible:ring-2 focus-visible:ring-coral"
          >
            {monthOptions().map((m) => (
              <option key={m} value={m}>
                {monthLabel(m)}
              </option>
            ))}
          </select>
          <span
            aria-hidden
            className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-[10px] leading-none text-ink/40"
          >
            ▼
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setMovingCash(true)}
            className="rounded-full bg-white px-4 py-2 text-sm font-black text-ink/70 shadow-btn transition-all hover:bg-ink/5 active:translate-y-0.5 active:shadow-btn-pressed"
          >
            💸 Cash out
          </button>
          <button
            onClick={() => setDeclaring(today)}
            className="rounded-full bg-coral px-4 py-2 text-sm font-black text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed"
          >
            {todayDeclared ? "Edit today" : "+ Declare today"}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="py-24 text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-ink/15 border-t-coral" />
        </div>
      ) : error ? (
        <div className="py-20 text-center">
          <p className="mb-3 text-5xl">🔑</p>
          <p className="mx-auto max-w-sm text-base font-bold text-coral">{error}</p>
        </div>
      ) : !data ? null : (
        <>
          {/* The one number the owner came for. Everything that moved it is
              spelled out underneath, in the order it moves: opening, what came
              in, what went out. */}
          <div className="mt-3 rounded-chunk bg-white p-5 shadow-chunk">
            <p className="text-sm font-black uppercase tracking-wide text-ink/40">
              Cash in store
            </p>
            <p className="mt-1 text-4xl font-black text-ink">{rupees(data.cashInStoreInr)}</p>
            <p className="mt-0.5 text-sm font-bold text-ink/50">
              {data.label}
              {data.startsOn !== `${data.month}-01` && ` · from ${dayLabel(data.startsOn)}`}
            </p>

            <dl className="mt-4 grid gap-x-8 sm:grid-cols-2">
              <Line
                label="Opening balance"
                value={rupees(data.openingInr)}
                hint={data.openingIsExplicit ? data.openingSetBy || "set" : "carried forward"}
                onEdit={isAdmin ? () => setEditingOpening(true) : undefined}
              />
              <Line label="Cash declared" value={`+ ${rupees(data.totals.declaredCash)}`} />
              <Line label="Cash spent on expenses" value={`− ${rupees(data.totals.cashSpent)}`} />
              {/* Stock is not spend — the money became socks — but it left the
                  drawer, so it belongs in this sum on a line of its own. */}
              <Line label="Cash spent on stock" value={`− ${rupees(data.totals.cashStock)}`} />
              <Line label="Cash taken out" value={`− ${rupees(data.totals.cashTakenOut)}`} />
            </dl>

            <MonthTally totals={data.totals} isAdmin={isAdmin} />

            <History edits={data.openingEdits} label="opening balance history" />
          </div>

          {data.missingDays.length > 0 && (
            <Notice tone="yellow">
              <strong className="font-black">
                {data.missingDays.length} day{data.missingDays.length === 1 ? "" : "s"} not declared
              </strong>{" "}
              — {data.missingDays.map(dayLabel).join(", ")}. The balance above is short by whatever
              came in on {data.missingDays.length === 1 ? "it" : "them"}.
            </Notice>
          )}
          {data.expensesError && <Notice tone="coral">{data.expensesError}</Notice>}
          {data.stockError && <Notice tone="coral">{data.stockError}</Notice>}
          {data.tallyError && <Notice tone="coral">{data.tallyError}</Notice>}

          {data.days.length === 0 ? (
            <p className="py-16 text-center text-base font-bold text-ink/40">
              Nothing to show for this month yet.
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {data.days.map((day) => (
                <DayCard
                  key={day.date}
                  day={day}
                  isAdmin={isAdmin}
                  isToday={day.date === today}
                  onDeclare={() => setDeclaring(day.date)}
                  onRemoveMovement={isAdmin ? removeMovement : undefined}
                />
              ))}
            </ul>
          )}
        </>
      )}

      {declaring && (
        <DeclareDaySheet
          day={declaring}
          existing={data?.days.find((d) => d.date === declaring)?.declared ?? null}
          staff={staff}
          onClose={() => setDeclaring(null)}
          onSaved={() => {
            setDeclaring(null);
            load();
          }}
        />
      )}

      {movingCash && (
        <MoveCashSheet
          today={today}
          staff={staff}
          onClose={() => setMovingCash(false)}
          onSaved={() => {
            setMovingCash(false);
            load();
          }}
        />
      )}

      {editingOpening && data && (
        <OpeningSheet
          month={data.month}
          label={data.label}
          current={data.openingInr}
          startsOn={data.startsOn}
          onClose={() => setEditingOpening(false)}
          onSaved={() => {
            setEditingOpening(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function Line({
  label,
  value,
  hint,
  onEdit,
}: {
  label: string;
  value: string;
  hint?: string;
  onEdit?: () => void;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-ink/5 py-1.5">
      <dt className="min-w-0 truncate text-sm font-bold text-ink/60">
        {label}
        {hint && <span className="ml-1.5 text-xs font-bold text-ink/30">{hint}</span>}
        {onEdit && (
          <button
            onClick={onEdit}
            className="ml-1.5 text-xs font-black text-coral underline-offset-2 hover:underline"
          >
            edit
          </button>
        )}
      </dt>
      <dd className="shrink-0 text-sm font-black text-ink">{value}</dd>
    </div>
  );
}

/**
 * The month's declared figures against Swipe's own — one comparison per row.
 *
 * Cash appears here as well as in the cash-flow sum above, and that's
 * deliberate: up there it's a term in "what's in the drawer", here it's one
 * half of "do the books agree". Same number, two different questions. The
 * version this replaces split the pair across both halves of the card and made
 * the reader do the subtraction themselves, which is the opposite of the point.
 *
 * Online has no place in the sum above at all — it never touches the drawer —
 * so this is the only place it's reckoned with.
 *
 * A zero difference is drawn as a dash, not "₹0": the eye should be able to
 * run down this column and stop only where something is wrong.
 */
function MonthTally({ totals, isAdmin }: { totals: LedgerMonth["totals"]; isAdmin: boolean }) {
  // The counter's payload carries no Swipe side at all, so there is nothing to
  // compare — it just sees what it declared.
  if (!isAdmin || totals.tallyCash === null || totals.tallyOnline === null) {
    return (
      <dl className="mt-3 grid gap-x-8 border-t-2 border-ink/5 pt-3 sm:grid-cols-2">
        <Line label="Online declared" value={rupees(totals.declaredOnline)} />
      </dl>
    );
  }

  const rows = [
    { label: "Cash", declared: totals.declaredCash, swipe: totals.tallyCash },
    { label: "Online", declared: totals.declaredOnline, swipe: totals.tallyOnline },
  ];

  return (
    <div className="mt-3 border-t-2 border-ink/5 pt-3">
      <p className="text-[11px] font-black uppercase tracking-wide text-ink/40">
        Declared against Swipe
      </p>
      {/* Sized to fit a 375px phone outright rather than scrolling: the first
          version scrolled, and what fell off the right edge was Difference —
          the one column anybody opens this block to read. The overflow rule
          stays as a backstop for a freak six-figure day. */}
      <div className="-mx-1 mt-1 overflow-x-auto px-1">
        <table className="w-full table-auto text-[11px] sm:text-sm">
          <thead>
            <tr className="text-[9px] font-black uppercase tracking-wide text-ink/30 sm:text-[10px]">
              <th />
              <th className="py-1 text-right font-black">Declared</th>
              <th className="py-1 text-right font-black">Swipe</th>
              <th className="py-1 text-right font-black">Difference</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const gap = Math.round(row.declared - (row.swipe ?? 0));
              return (
                <tr key={row.label} className="border-t border-ink/5">
                  <td className="py-1.5 pr-2 text-left font-bold text-ink/60">{row.label}</td>
                  <td className="whitespace-nowrap py-1.5 pl-2 text-right font-black text-ink">
                    {rupees(row.declared)}
                  </td>
                  <td className="whitespace-nowrap py-1.5 pl-2 text-right font-bold text-ink/50">
                    {rupees(row.swipe ?? 0)}
                  </td>
                  <td
                    className={`whitespace-nowrap py-1.5 pl-2 text-right font-black ${
                      gap === 0 ? "text-ink/25" : "text-coral"
                    }`}
                  >
                    {gap === 0 ? "—" : `${gap > 0 ? "+" : "−"}${rupees(Math.abs(gap))}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Notice({ tone, children }: { tone: "yellow" | "coral"; children: React.ReactNode }) {
  return (
    <p
      className={`mt-3 rounded-2xl px-4 py-3 text-sm font-bold ${
        tone === "yellow" ? "bg-yellow/25 text-ink" : "bg-coral/15 text-ink"
      }`}
    >
      {children}
    </p>
  );
}

/** One day: what was counted, what Swipe says, and what's left in the drawer. */
function DayCard({
  day,
  isAdmin,
  isToday,
  onDeclare,
  onRemoveMovement,
}: {
  day: LedgerDay;
  isAdmin: boolean;
  isToday: boolean;
  onDeclare: () => void;
  /** Undefined for the counter — removing a logged withdrawal is owner-only. */
  onRemoveMovement?: (id: string) => void;
}) {
  const cashGap = day.declared && day.tally ? day.declared.cashInr - day.tally.cash : 0;
  const onlineGap = day.declared && day.tally ? day.declared.onlineInr - day.tally.online : 0;

  return (
    <li className="rounded-2xl bg-white p-3.5 shadow-chunk">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-base font-black text-ink">
            {dayLabel(day.date)}
            {isToday && <span className="ml-1.5 text-sm font-bold text-ink/30">today</span>}
          </p>
          {day.declared?.enteredBy && (
            <p className="text-xs font-bold text-ink/30">counted by {day.declared.enteredBy}</p>
          )}
        </div>
        <div className="shrink-0 text-right">
          <p className="text-lg font-black text-ink">{rupees(day.closingInr)}</p>
          <p className="text-[11px] font-bold uppercase tracking-wide text-ink/30">in store</p>
        </div>
      </div>

      {day.declared ? (
        <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
          <Cell
            label="Cash"
            declared={day.declared.cashInr}
            tally={day.tally?.cash ?? null}
            gap={cashGap}
            showTally={isAdmin}
          />
          <Cell
            label="Online"
            declared={day.declared.onlineInr}
            tally={day.tally?.online ?? null}
            gap={onlineGap}
            showTally={isAdmin}
          />
        </div>
      ) : (
        <div className="mt-2.5 flex items-center justify-between gap-3 rounded-xl bg-cream/70 px-3 py-2">
          <span className="text-sm font-bold text-ink/40">Not declared</span>
          <button
            onClick={onDeclare}
            className="rounded-full bg-ink px-3 py-1.5 text-xs font-black text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed"
          >
            Declare
          </button>
        </div>
      )}

      {day.declared && (
        <button
          onClick={onDeclare}
          className="mt-2 text-xs font-black text-coral underline-offset-2 hover:underline"
        >
          Edit this day
        </button>
      )}

      {day.declared?.note && (
        <p className="mt-1.5 text-sm font-bold text-ink/50">{day.declared.note}</p>
      )}

      {(day.cashSpentInr > 0 || day.cashStockInr > 0 || day.movements.length > 0) && (
        <ul className="mt-2.5 space-y-1 border-t-2 border-ink/5 pt-2">
          {day.cashSpentInr > 0 && (
            <li className="flex items-baseline justify-between gap-3 text-sm font-bold text-ink/50">
              <span>Cash expenses</span>
              <span className="shrink-0 font-black text-ink/70">− {rupees(day.cashSpentInr)}</span>
            </li>
          )}
          {/* Named, not just totalled: "what did that ₹375 go on" is the first
              thing anyone asks of a stock figure, and the PINV- serial takes
              them straight to the document. */}
          {day.stockBought.map((p) => (
            <li
              key={p.serialNumber}
              className="flex items-baseline justify-between gap-3 text-sm font-bold text-ink/50"
            >
              <span className="min-w-0 truncate">
                Stock · {p.vendor}
                <span className="ml-1.5 text-xs font-bold text-ink/30">{p.serialNumber}</span>
              </span>
              <span className="shrink-0 font-black text-ink/70">− {rupees(p.amountInr)}</span>
            </li>
          ))}
          {day.movements.map((m) => (
            <MovementRow
              key={m.id}
              movement={m}
              onRemove={onRemoveMovement && (() => onRemoveMovement(m.id))}
            />
          ))}
        </ul>
      )}

      <History edits={day.edits} label="what changed" />
    </li>
  );
}

/** One side of the tally. The counter sees only what they declared. */
function Cell({
  label,
  declared,
  tally,
  gap,
  showTally,
}: {
  label: string;
  declared: number;
  tally: number | null;
  gap: number;
  showTally: boolean;
}) {
  return (
    <div className="rounded-xl bg-cream/70 px-3 py-2">
      <p className="text-[11px] font-black uppercase tracking-wide text-ink/40">{label}</p>
      <p className="text-lg font-black text-ink">{rupees(declared)}</p>
      {showTally && tally !== null && (
        <p className="text-xs font-bold text-ink/40">
          Swipe {rupees(tally)}
          {/* Only a real gap is drawn. "₹0 off" on every matching row would
              train the eye to skip exactly the thing worth noticing. */}
          {Math.round(gap) !== 0 && (
            <span className="ml-1.5 rounded-full bg-coral px-2 py-0.5 text-[11px] font-black text-cream">
              {gap > 0 ? "+" : "−"}
              {rupees(Math.abs(gap))}
            </span>
          )}
        </p>
      )}
    </div>
  );
}

/** "9:12 PM, Sun 6 Sept" — when a change was made. */
function editStamp(at: number): string {
  return new Date(at).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "numeric",
    minute: "2-digit",
    day: "numeric",
    month: "short",
  });
}

/**
 * What was done to a figure, and by whom.
 *
 * Collapsed by default and never louder than the figures themselves: on a
 * normal day it's one grey line saying nothing happened out of the ordinary,
 * and it only earns attention when someone goes looking.
 */
function History({ edits, label = "history" }: { edits: LedgerEdit[]; label?: string }) {
  const [open, setOpen] = useState(false);
  if (edits.length === 0) return null;

  // What counts as an edit is a change to something that already existed —
  // writing a figure down the first time isn't one. Counted by action rather
  // than by "everything after the first entry", because the history doesn't
  // necessarily reach back to the creation: figures entered before this log
  // existed have updates recorded with no creation above them.
  const corrections = edits.filter((e) => e.action !== "created").length;

  return (
    <div className="mt-2">
      <button
        onClick={() => setOpen(!open)}
        className="text-xs font-black text-ink/40 underline-offset-2 hover:text-ink/70 hover:underline"
      >
        {corrections > 0
          ? `Edited ${corrections}× · ${label}`
          : `Unchanged since it was entered · ${label}`}
        <span aria-hidden className="ml-1">
          {open ? "▲" : "▼"}
        </span>
      </button>

      {open && (
        <ol className="mt-1.5 space-y-1 border-l-2 border-ink/10 pl-3">
          {edits.map((e) => (
            <li key={e.id} className="text-xs font-bold text-ink/50">
              <span className="text-ink/70">{e.summary}</span>
              <br />
              {editStamp(e.at)}
              {/* The name is typed on a form; the tier is proved by the cookie
                  that was presented. Say which is which rather than running
                  them together as if both were verified. */}
              {e.by && ` · ${e.by}`}
              <span className="ml-1 rounded-full bg-ink/5 px-1.5 py-0.5 text-[10px] font-black uppercase tracking-wide text-ink/40">
                {e.tier}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function MovementRow({
  movement,
  onRemove,
}: {
  movement: CashMovement;
  onRemove?: () => void;
}) {
  const out = movement.direction === "out";
  return (
    <li className="flex items-baseline justify-between gap-3 text-sm font-bold text-ink/50">
      <span className="min-w-0 truncate">
        {out ? "Taken out" : "Put in"}
        {movement.party && ` · ${movement.party}`}
        {movement.reason && ` · ${movement.reason}`}
        {onRemove && (
          <button
            onClick={onRemove}
            className="ml-1.5 text-xs font-black text-coral underline-offset-2 hover:underline"
          >
            remove
          </button>
        )}
      </span>
      <span className="shrink-0 font-black text-ink/70">
        {out ? "−" : "+"} {rupees(movement.amountInr)}
      </span>
    </li>
  );
}

// ── Sheets ───────────────────────────────────────────────────────────────────

function Sheet({
  title,
  subtitle,
  busy,
  error,
  submitLabel,
  onClose,
  onSubmit,
  valid,
  children,
}: {
  title: string;
  subtitle?: string;
  busy: boolean;
  error: string | null;
  submitLabel: string;
  onClose: () => void;
  onSubmit: (e: React.FormEvent) => void;
  valid: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-ink/40" onClick={busy ? undefined : onClose} />
      <form
        onSubmit={onSubmit}
        className="relative w-full max-w-md rounded-t-chunk bg-cream p-5 sm:rounded-chunk"
      >
        <h2 className="text-xl font-black text-ink">{title}</h2>
        {subtitle && <p className="mt-0.5 text-sm font-bold text-ink/50">{subtitle}</p>}
        {children}
        {error && <p className="mt-2 px-1 text-sm font-bold text-coral">{error}</p>}
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-full bg-white py-3 text-base font-black text-ink/60 hover:bg-ink/10"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !valid}
            className="flex-1 rounded-full bg-ink py-3 text-base font-black text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed disabled:opacity-40"
          >
            {busy ? "Saving…" : submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

const inputClass =
  "w-full rounded-2xl border-2 border-ink/10 bg-white px-4 py-3 text-base font-bold text-ink outline-none placeholder:text-ink/30 focus:border-coral";
const moneyClass =
  "w-full rounded-2xl border-2 border-ink/10 bg-white px-4 py-3 text-2xl font-black text-ink outline-none placeholder:text-ink/20 focus:border-coral";
const selectClass =
  "w-full cursor-pointer appearance-none rounded-2xl border-2 border-ink/10 bg-white py-3 pl-4 pr-10 text-base font-bold text-ink outline-none focus:border-coral";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="mt-3 block">
      <span className="mb-1.5 block px-1 text-sm font-black text-ink/60">{label}</span>
      {children}
    </label>
  );
}

function StaffPicker({
  staff,
  value,
  onChange,
  label,
  placeholder,
}: {
  staff: string[];
  value: string;
  onChange: (v: string) => void;
  label: string;
  placeholder: string;
}) {
  if (staff.length === 0) return null;
  return (
    <Field label={label}>
      <span className="relative block">
        <select value={value} onChange={(e) => onChange(e.target.value)} className={selectClass}>
          <option value="" disabled>
            {placeholder}
          </option>
          {staff.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <span
          aria-hidden
          className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-[10px] leading-none text-ink/40"
        >
          ▼
        </span>
      </span>
    </Field>
  );
}

const money = (v: string) => v.replace(/[^\d.]/g, "");

function DeclareDaySheet({
  day,
  existing,
  staff,
  onClose,
  onSaved,
}: {
  day: string;
  existing: { cashInr: number; onlineInr: number; note: string; enteredBy: string } | null;
  staff: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [cash, setCash] = useState(existing ? String(existing.cashInr) : "");
  const [online, setOnline] = useState(existing ? String(existing.onlineInr) : "");
  const [note, setNote] = useState(existing?.note ?? "");
  const [enteredBy, setEnteredBy] = useState(existing?.enteredBy ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/ops/ledger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          day,
          cashInr: Number(cash || 0),
          onlineInr: Number(online || 0),
          note,
          enteredBy,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error || "Couldn't save");
        return;
      }
      onSaved();
    } catch {
      setError("Network error — please retry");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      title={existing ? `Edit ${dayLabel(day)}` : `Declare ${dayLabel(day)}`}
      subtitle="What the counter took today. Count the cash; read the online figure off the machine."
      busy={busy}
      error={error}
      submitLabel="Save day"
      onClose={onClose}
      onSubmit={submit}
      valid={cash !== "" || online !== ""}
    >
      <Field label="Cash taken">
        <input
          inputMode="decimal"
          value={cash}
          onChange={(e) => setCash(money(e.target.value))}
          autoFocus
          placeholder="0"
          className={moneyClass}
        />
      </Field>
      <Field label="Online taken (card + UPI)">
        <input
          inputMode="decimal"
          value={online}
          onChange={(e) => setOnline(money(e.target.value))}
          placeholder="0"
          className={moneyClass}
        />
      </Field>
      <StaffPicker
        staff={staff}
        value={enteredBy}
        onChange={setEnteredBy}
        label="Counted by"
        placeholder="Who counted it?"
      />
      <Field label="Note (optional)">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. ₹200 short, machine slip attached"
          className={inputClass}
        />
      </Field>
    </Sheet>
  );
}

/**
 * Cash moving for a reason that isn't a sale or an expense — almost always the
 * owner taking money out, which is why "out" is the default and the form talks
 * about who took it.
 */
function MoveCashSheet({
  today,
  staff,
  onClose,
  onSaved,
}: {
  today: string;
  staff: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [day, setDay] = useState(today);
  const [amount, setAmount] = useState("");
  const [party, setParty] = useState("");
  const [recordedBy, setRecordedBy] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/ops/ledger/movement", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          day,
          amountInr: Number(amount || 0),
          party,
          recordedBy,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error || "Couldn't save");
        return;
      }
      onSaved();
    } catch {
      setError("Network error — please retry");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      title="Cash taken out"
      subtitle="Money leaving the drawer that isn't an expense — the owner's draw, a bank deposit."
      busy={busy}
      error={error}
      submitLabel="Save"
      onClose={onClose}
      onSubmit={submit}
      valid={Number(amount) > 0}
    >
      <Field label="Amount">
        <input
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(money(e.target.value))}
          autoFocus
          placeholder="0"
          className={moneyClass}
        />
      </Field>
      <Field label="Day">
        <input
          type="date"
          value={day}
          max={today}
          onChange={(e) => setDay(e.target.value)}
          className={inputClass}
        />
      </Field>
      <Field label="Taken by">
        <input
          value={party}
          onChange={(e) => setParty(e.target.value)}
          placeholder="e.g. Owner"
          className={inputClass}
        />
      </Field>
      <StaffPicker
        staff={staff}
        value={recordedBy}
        onChange={setRecordedBy}
        label="Recorded by"
        placeholder="Who's logging this?"
      />
    </Sheet>
  );
}

/** Owner-only: pin a month's opening balance. */
function OpeningSheet({
  month,
  label,
  current,
  startsOn,
  onClose,
  onSaved,
}: {
  month: string;
  label: string;
  current: number;
  startsOn: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [amount, setAmount] = useState(String(Math.round(current)));
  const [from, setFrom] = useState(startsOn);
  const [setBy, setSetBy] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/ops/ledger/opening", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          month,
          openingInr: Number(amount || 0),
          startsOn: from,
          setBy,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error || "Couldn't save");
        return;
      }
      onSaved();
    } catch {
      setError("Network error — please retry");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      title={`Opening balance — ${label}`}
      subtitle="Cash in the store when this month's ledger starts. Setting it pins it: it stops being carried forward from last month."
      busy={busy}
      error={error}
      submitLabel="Set opening"
      onClose={onClose}
      onSubmit={submit}
      valid={amount !== ""}
    >
      <Field label="Cash counted">
        <input
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(money(e.target.value))}
          autoFocus
          placeholder="0"
          className={moneyClass}
        />
      </Field>
      <Field label="Ledger starts on">
        <input
          type="date"
          value={from}
          min={`${month}-01`}
          onChange={(e) => setFrom(e.target.value)}
          className={inputClass}
        />
      </Field>
      <Field label="Set by (optional)">
        <input
          value={setBy}
          onChange={(e) => setSetBy(e.target.value)}
          placeholder="e.g. Owner"
          className={inputClass}
        />
      </Field>
    </Sheet>
  );
}
