/**
 * Per-employee PIN auth for /staff.
 *
 * Separate from the shared OPS_PASSWORD gate (../ops/auth): employees mark
 * their own attendance and apply for their own leave, so they must not need
 * the manager password — and a manager approving leave must not be doing it as
 * "whoever holds the tablet".
 *
 * A 4-digit PIN has only 10k values, so it is stretched with scrypt and a
 * per-employee salt. That makes a stolen database dump expensive to grind;
 * online guessing is held off by a short lockout in ./ratelimit.
 */

import { cookies } from "next/headers";
import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: string,
  keylen: number
) => Promise<Buffer>;

export const STAFF_COOKIE = "pp_staff";
const COOKIE_MAX_AGE = 60 * 60 * 12; // a shift, not a month
const KEYLEN = 32;

export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const key = await scrypt(pin, salt, KEYLEN);
  return `scrypt:${salt}:${key.toString("hex")}`;
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const [scheme, salt, hex] = stored.split(":");
  if (scheme !== "scrypt" || !salt || !hex) return false;
  const key = await scrypt(pin, salt, KEYLEN);
  const expected = Buffer.from(hex, "hex");
  if (expected.length !== key.length) return false;
  return timingSafeEqual(key, expected);
}

/**
 * The signed-in employee id, or null. The cookie is httpOnly and holds the
 * employee id plus an HMAC over it, so a client can't rewrite it into someone
 * else's id. Signed with OPS_PASSWORD — the one secret this app already has.
 */
export async function currentEmployeeId(): Promise<string | null> {
  const raw = (await cookies()).get(STAFF_COOKIE)?.value;
  if (!raw) return null;
  const [id, sig] = raw.split(".");
  if (!id || !sig) return null;
  const expected = signEmployeeId(id);
  if (!expected) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  return timingSafeEqual(a, b) ? id : null;
}

function signEmployeeId(id: string): string | null {
  const secret = process.env.OPS_PASSWORD;
  if (!secret) return null;
  return createHmac("sha256", secret).update(`staff:${id}`).digest("hex");
}

export function staffCookie(employeeId: string): { name: string; value: string } & Record<string, unknown> {
  const sig = signEmployeeId(employeeId);
  if (!sig) throw new Error("OPS_PASSWORD must be set to sign staff sessions");
  return {
    name: STAFF_COOKIE,
    value: `${employeeId}.${sig}`,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  };
}
