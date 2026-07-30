/**
 * Check-in / check-out state for today's sessions, in the same Upstash Redis
 * the Swipe token lives in (KV_REST_API_URL/TOKEN).
 *
 * Keys are day-scoped IST hashes that expire at midnight IST:
 *   checkouts:YYYY-MM-DD  — sessionId → unix ms  (SAME key pp-billing uses, so
 *                           both dashboards stay in sync during the transition)
 *   checkins:YYYY-MM-DD   — sessionId → unix ms  (new: when the timer starts
 *                           for app bookings validated at the counter)
 */

const CHECKINS_PREFIX = "checkins";
const CHECKOUTS_PREFIX = "checkouts";

// ── Upstash REST transport ───────────────────────────────────────────────────

function kvConfig(): { url: string; token: string } {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error("Redis not configured — set KV_REST_API_URL and KV_REST_API_TOKEN");
  }
  return { url, token };
}

/** Single-command Upstash REST call, e.g. redisCommand(["HSET", key, field, value]). */
export async function redisCommand<T>(command: (string | number)[]): Promise<T> {
  const { url, token } = kvConfig();
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(command.map(String)),
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as { result?: T; error?: string };
  if (!res.ok || body.error) {
    throw new Error(`Redis ${command[0]} failed: ${body.error ?? res.status}`);
  }
  return body.result as T;
}

// ── Day scoping (IST) ────────────────────────────────────────────────────────

/** Today's date in IST as YYYY-MM-DD. */
export function todayIST(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Unix seconds at the next midnight IST — when today's state expires. */
function endOfTodayISTUnix(): number {
  const [y, m, d] = todayIST().split("-").map(Number);
  // Midnight IST at the END of today = start of tomorrow IST = (UTC of today's
  // date at 00:00) + 1 day − 5h30m.
  const startOfTodayUTC = Date.UTC(y, m - 1, d) - 5.5 * 60 * 60 * 1000;
  return Math.floor((startOfTodayUTC + 24 * 60 * 60 * 1000) / 1000);
}

// ── State API ────────────────────────────────────────────────────────────────

/** sessionId → unix ms map for one of today's hashes. */
async function readDayHash(prefix: string): Promise<Record<string, number>> {
  // HGETALL over REST returns a flat [field, value, field, value, ...] array.
  const flat = await redisCommand<string[] | null>(["HGETALL", `${prefix}:${todayIST()}`]);
  const out: Record<string, number> = {};
  if (!flat) return out;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const ts = Number(flat[i + 1]);
    if (!isNaN(ts)) out[flat[i]] = ts;
  }
  return out;
}

async function setDayHash(prefix: string, sessionId: string, at: number): Promise<void> {
  const key = `${prefix}:${todayIST()}`;
  await redisCommand(["HSET", key, sessionId, at]);
  await redisCommand(["EXPIREAT", key, endOfTodayISTUnix()]);
}

async function clearDayHash(prefix: string, sessionId: string): Promise<void> {
  await redisCommand(["HDEL", `${prefix}:${todayIST()}`, sessionId]);
}

export const getCheckins = () => readDayHash(CHECKINS_PREFIX);
export const setCheckin = (sessionId: string, at = Date.now()) =>
  setDayHash(CHECKINS_PREFIX, sessionId, at);
export const clearCheckin = (sessionId: string) => clearDayHash(CHECKINS_PREFIX, sessionId);

export const getCheckouts = () => readDayHash(CHECKOUTS_PREFIX);
export const setCheckout = (sessionId: string, at = Date.now()) =>
  setDayHash(CHECKOUTS_PREFIX, sessionId, at);
export const clearCheckout = (sessionId: string) => clearDayHash(CHECKOUTS_PREFIX, sessionId);
