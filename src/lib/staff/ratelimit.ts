/**
 * PIN lockout. A 4-digit PIN is guessable in 10k tries, so wrong attempts are
 * counted per employee in the Redis the rest of the app already uses and the
 * account is frozen for a few minutes once the count runs out.
 *
 * Redis being down must not lock the whole team out of marking attendance, so
 * a transport failure fails open — the scrypt hashing in ./auth is what makes
 * a stolen dump expensive, and this is the online-guessing speed bump.
 */

import { redisCommand } from "../ops/state";

const MAX_ATTEMPTS = 5;
const WINDOW_SECONDS = 10 * 60;

const keyFor = (employeeId: string) => `staff-pin-fails:${employeeId}`;

export interface LockoutState {
  locked: boolean;
  /** Attempts left before the lockout kicks in. */
  remaining: number;
}

export async function checkLockout(employeeId: string): Promise<LockoutState> {
  try {
    const fails = Number(await redisCommand<string | null>(["GET", keyFor(employeeId)])) || 0;
    return { locked: fails >= MAX_ATTEMPTS, remaining: Math.max(0, MAX_ATTEMPTS - fails) };
  } catch {
    return { locked: false, remaining: MAX_ATTEMPTS };
  }
}

export async function recordFailure(employeeId: string): Promise<LockoutState> {
  try {
    const key = keyFor(employeeId);
    const fails = await redisCommand<number>(["INCR", key]);
    // Refresh the window on every miss, so a slow grind can't outlast it.
    await redisCommand(["EXPIRE", key, WINDOW_SECONDS]);
    return { locked: fails >= MAX_ATTEMPTS, remaining: Math.max(0, MAX_ATTEMPTS - fails) };
  } catch {
    return { locked: false, remaining: MAX_ATTEMPTS };
  }
}

export async function clearFailures(employeeId: string): Promise<void> {
  try {
    await redisCommand(["DEL", keyFor(employeeId)]);
  } catch {
    // Nothing to do — the counter expires on its own.
  }
}

export const LOCKOUT_MESSAGE = `Too many wrong PINs. Try again in ${WINDOW_SECONDS / 60} minutes or ask the manager to reset it.`;
