/**
 * Wire types + status math for the ops session monitor. Pure and shared by the
 * /api/ops/sessions route (producer) and the client dashboard (consumer) —
 * keep it free of server-only imports.
 */

/** What /api/ops/sessions sends per card: a TodaySession with the secret code
 *  replaced by `needsCheckIn`, merged with today's check-in/out state. */
export interface OpsSession {
  id: string;
  invoiceNumber: string;
  kidNames: string[];
  parentName: string;
  phone: string;
  /** Invoice creation, unix ms — the timer start for walk-ins. */
  bookedAt: number;
  /** Play minutes; 0 = untimed (membership visit). */
  durationMinutes: number;
  products: string[];
  kidCount: number;
  isMembership: boolean;
  paid: boolean;
  /** Amount still to collect, INR (0 when settled; tracks partial payments). */
  amountDue: number;
  /** App booking → manager must validate the code before the timer starts. */
  needsCheckIn: boolean;
  checkinAt: number | null;
  checkoutAt: number | null;
  /** True for locally-added membership visits (no invoice behind them). */
  isManual?: boolean;
}

export type OpsStatus = "waiting" | "active" | "expiring" | "expired" | "checked_out";

export const EXPIRING_WINDOW_MS = 10 * 60 * 1000;

/**
 * Grace period added after check-in so the entry procedure (socks, briefing)
 * doesn't eat into paid play time. Applies only to code-validated check-ins;
 * walk-in timers run from invoice time as before.
 */
export const CHECKIN_BUFFER_MINUTES = 2;

/** When this session's clock started, or null while awaiting check-in. */
export function opsStartTime(s: OpsSession): number | null {
  if (s.needsCheckIn) return s.checkinAt;
  return s.bookedAt;
}

/** When this session's time is up, or null (awaiting check-in / untimed). */
export function opsEndTime(s: OpsSession): number | null {
  const start = opsStartTime(s);
  if (start == null || s.durationMinutes <= 0) return null;
  const bufferMinutes = s.needsCheckIn && s.checkinAt != null ? CHECKIN_BUFFER_MINUTES : 0;
  return start + (s.durationMinutes + bufferMinutes) * 60 * 1000;
}

export function computeOpsStatus(s: OpsSession, now: number): OpsStatus {
  if (s.checkoutAt != null) return "checked_out";
  if (s.needsCheckIn && s.checkinAt == null) return "waiting";
  const end = opsEndTime(s);
  if (end == null) return "active"; // untimed membership visit
  const remaining = end - now;
  if (remaining <= 0) return "expired";
  if (remaining <= EXPIRING_WINDOW_MS) return "expiring";
  return "active";
}
