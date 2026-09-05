/**
 * Ops password gate — protects /ops and the /api/ops/* routes so customers who
 * find the URL can't see sessions or check anyone in. Same scheme as
 * pp-billing's payment-summary gate: one shared password (OPS_PASSWORD env),
 * verified once and remembered via an httpOnly cookie holding a salted hash.
 *
 * There are two tiers, not two logins. Everyone types into the same box on the
 * same gate; which password they type decides what they get:
 *
 *   OPS_PASSWORD    the counter — every staff tool, and the cash ledger's
 *                   entry side (declare the day, log a withdrawal)
 *   ADMIN_PASSWORD  the owner — the above, plus the money views: the Swipe
 *                   tally, the variance, and setting a month's opening balance
 *
 * Admin therefore implies ops (logging in as admin sets both cookies), so no
 * existing check had to learn about tiers. Only the handful of places that
 * show owner-only numbers ask `isAdminAuthed()`.
 *
 * This is a shared password, not an identity: it says what you may see, never
 * who you are. Anything that needs a name (who declared the day, who took the
 * cash) asks for one on the form and stores it alongside the row.
 */

import { cookies } from "next/headers";
import { createHash, timingSafeEqual } from "crypto";

export const OPS_AUTH_COOKIE = "pp_ops_auth";
export const ADMIN_AUTH_COOKIE = "pp_admin_auth";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

interface Tier {
  cookie: string;
  env: "OPS_PASSWORD" | "ADMIN_PASSWORD";
  salt: string;
}

const OPS: Tier = { cookie: OPS_AUTH_COOKIE, env: "OPS_PASSWORD", salt: "app-playpanda:ops" };
const ADMIN: Tier = {
  cookie: ADMIN_AUTH_COOKIE,
  env: "ADMIN_PASSWORD",
  salt: "app-playpanda:admin",
};

function expectedCookieValue(tier: Tier): string | null {
  const password = process.env[tier.env];
  if (!password) return null;
  return createHash("sha256").update(`${password}:${tier.salt}`).digest("hex");
}

async function isAuthed(tier: Tier): Promise<boolean> {
  const expected = expectedCookieValue(tier);
  if (!expected) return false;
  const got = (await cookies()).get(tier.cookie)?.value;
  if (!got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function verify(tier: Tier, input: string): string | null {
  const password = process.env[tier.env];
  if (!password) return null;
  const a = Buffer.from(input);
  const b = Buffer.from(password);
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;
  return expectedCookieValue(tier);
}

function cookieOptions(name: string) {
  return {
    name,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  };
}

export function isOpsAuthed(): Promise<boolean> {
  return isAuthed(OPS);
}

/** The owner tier. Never assume it from `isOpsAuthed` — check it explicitly. */
export function isAdminAuthed(): Promise<boolean> {
  return isAuthed(ADMIN);
}

/** Returns the cookie value to set when the password matches, else null. */
export function verifyOpsPassword(input: string): string | null {
  return verify(OPS, input);
}

export function verifyAdminPassword(input: string): string | null {
  return verify(ADMIN, input);
}

export function opsCookieOptions() {
  return cookieOptions(OPS_AUTH_COOKIE);
}

export function adminCookieOptions() {
  return cookieOptions(ADMIN_AUTH_COOKIE);
}
