/**
 * Membership domain types shared by server (db, routes) and client (UI).
 * Keep this file dependency-free — client components import it, so nothing
 * server-only (pg, node APIs) may leak in here.
 */

export interface Membership {
  id: string;
  phone: string;
  customerName: string;
  /** Comma-separated kid names, informational. */
  kidNames: string;
  planKey: string;
  planName: string;
  punchProductId: number;
  punchProductName: string;
  /** null = unlimited plays during validity. */
  totalPlays: number | null;
  hoursPerPlay: number;
  kidsPerPlay: number;
  priceInr: number | null;
  /** The manually-billed Swipe sale invoice, if the manager noted it. */
  saleInvoiceNumber: string;
  weekdaysOnly: boolean;
  oncePerDay: boolean;
  startsOn: string; // YYYY-MM-DD (IST)
  expiresOn: string; // YYYY-MM-DD (IST) — the expiry day itself is usable
  notes: string;
  createdAt: number; // unix ms
  /** Total plays consumed so far (computed from visits). */
  playsUsed: number;
}

export interface MembershipVisit {
  id: string;
  membershipId: string;
  phone: string;
  kidsCount: number;
  playsUsed: number;
  kidNames: string;
  visitDate: string; // YYYY-MM-DD (IST)
  punchInvoiceNumber: string;
  visitedAt: number; // unix ms
}

export type MembershipStatus = "active" | "expired" | "exhausted";

export function playsLeft(m: Membership): number | null {
  return m.totalPlays == null ? null : Math.max(0, m.totalPlays - m.playsUsed);
}

export function membershipStatus(m: Membership, todayIST: string): MembershipStatus {
  if (todayIST > m.expiresOn) return "expired";
  const left = playsLeft(m);
  if (left !== null && left <= 0) return "exhausted";
  return "active";
}

/** Plays one visit consumes: each play covers `kidsPerPlay` kids. */
export function playsForKids(kidsCount: number, kidsPerPlay: number): number {
  return Math.ceil(kidsCount / Math.max(1, kidsPerPlay));
}

/** Normalize to the bare 10-digit Indian mobile number. */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/** Mon–Fri check for a YYYY-MM-DD date (date-only, timezone-independent). */
export function isWeekday(date: string): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day >= 1 && day <= 5;
}
