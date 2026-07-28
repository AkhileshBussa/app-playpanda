/**
 * Ops password gate — protects /ops and the /api/ops/* routes so customers who
 * find the URL can't see sessions or check anyone in. Same scheme as
 * pp-billing's payment-summary gate: one shared password (OPS_PASSWORD env),
 * verified once and remembered via an httpOnly cookie holding a salted hash.
 */

import { cookies } from "next/headers";
import { createHash, timingSafeEqual } from "crypto";

export const OPS_AUTH_COOKIE = "pp_ops_auth";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days
const SALT = "app-playpanda:ops";

function expectedCookieValue(): string | null {
  const password = process.env.OPS_PASSWORD;
  if (!password) return null;
  return createHash("sha256").update(`${password}:${SALT}`).digest("hex");
}

export async function isOpsAuthed(): Promise<boolean> {
  const expected = expectedCookieValue();
  if (!expected) return false;
  const got = (await cookies()).get(OPS_AUTH_COOKIE)?.value;
  if (!got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Returns the cookie value to set when the password matches, else null. */
export function verifyOpsPassword(input: string): string | null {
  const password = process.env.OPS_PASSWORD;
  if (!password) return null;
  const a = Buffer.from(input);
  const b = Buffer.from(password);
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;
  return expectedCookieValue();
}

export function opsCookieOptions() {
  return {
    name: OPS_AUTH_COOKIE,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  };
}
