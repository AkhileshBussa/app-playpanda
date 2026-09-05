/**
 * Calendar helpers for the cash ledger.
 *
 * A ledger day is an IST calendar day, always written "YYYY-MM-DD", and a
 * month is "YYYY-MM". Every conversion here is explicitly zoned: the drawer is
 * counted at closing time in Bengaluru, and a plain `new Date()` on a server
 * in another timezone would file the last five and a half hours of trading
 * under the wrong day.
 */

const IST = "Asia/Kolkata";

/** Today in IST, "YYYY-MM-DD". */
export function istToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: IST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** The month a day belongs to: "2026-09-06" → "2026-09". */
export function monthOf(day: string): string {
  return day.slice(0, 7);
}

export function previousMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Last day of the month, "YYYY-MM-DD". */
export function monthEnd(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, "0")}`;
}

export function monthStart(month: string): string {
  return `${month}-01`;
}

/** "September 2026". */
export function monthLabel(month: string): string {
  return new Date(`${month}-15T00:00:00Z`).toLocaleDateString("en-IN", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Every day from `from` to `to` inclusive; empty when `to` is before `from`. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  // Bounded: a range longer than a month can only be a bug upstream.
  for (let day = from, guard = 0; day <= to && guard < 40; day = shiftDays(day, 1), guard++) {
    out.push(day);
  }
  return out;
}

/** Calendar-day arithmetic, done in UTC so it can't drift across a DST edge. */
export function shiftDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** "YYYY-MM-DD" → "DD-MM-YYYY", the format Swipe's filters take. */
export function toSwipeDate(day: string): string {
  const [y, m, d] = day.split("-");
  return `${d}-${m}-${y}`;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Swipe's human date, "07 Aug 2026" → "2026-08-07"; null if unparseable. */
export function fromSwipeDisplayDate(value: string): string | null {
  const m = value.trim().match(/^(\d{1,2}) ([A-Za-z]{3})[a-z]* (\d{4})$/);
  if (!m) return null;
  const month = MONTHS.indexOf(m[2].toLowerCase());
  if (month < 0) return null;
  return `${m[3]}-${String(month + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

export const isDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
export const isMonth = (v: string) => /^\d{4}-\d{2}$/.test(v);
