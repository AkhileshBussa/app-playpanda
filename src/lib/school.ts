/**
 * School-visit kid log — shared note-taking for school partnership events, in
 * the same Upstash Redis as the ops check-in state.
 *
 * Several staff take notes at once, so nothing here read-modify-writes a
 * shared blob: every entry gets a unique id and lives in its own field of a
 * day-scoped hash (HSET/HDEL are atomic per field). Concurrent adds can't
 * lose each other; readers poll and merge. Two people noting the same kid at
 * the same moment yields two visible entries — the UI warns about duplicates
 * and any entry can be removed with one tap.
 *
 * Keys: school-kids:YYYY-MM-DD (IST) — entryId → JSON {kidName, className, at}
 * Kept for 60 days (useful for partnership follow-up), unlike the
 * midnight-expiring check-in keys.
 */

import { randomUUID } from "crypto";
import { redisCommand, todayIST } from "./ops/state";

const KEY_PREFIX = "school-kids";
const RETENTION_SECONDS = 60 * 24 * 60 * 60;

export interface SchoolKidEntry {
  id: string;
  kidName: string;
  className: string;
  /** When the kid was noted, unix ms. */
  at: number;
}

const keyFor = (date: string) => `${KEY_PREFIX}:${date}`;

/** All entries for a day (defaults to today IST), in arrival order. */
export async function listSchoolKids(date = todayIST()): Promise<SchoolKidEntry[]> {
  // HGETALL over REST returns a flat [field, value, field, value, ...] array.
  const flat = await redisCommand<string[] | null>(["HGETALL", keyFor(date)]);
  const out: SchoolKidEntry[] = [];
  if (!flat) return out;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    try {
      const parsed = JSON.parse(flat[i + 1]) as Omit<SchoolKidEntry, "id">;
      out.push({ ...parsed, id: flat[i] });
    } catch {
      // Skip a malformed entry rather than break everyone's list.
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Note a kid (always on today's list). */
export async function addSchoolKid(
  kidName: string,
  className: string
): Promise<SchoolKidEntry> {
  const entry: SchoolKidEntry = { id: randomUUID(), kidName, className, at: Date.now() };
  const key = keyFor(todayIST());
  await redisCommand([
    "HSET",
    key,
    entry.id,
    JSON.stringify({ kidName, className, at: entry.at }),
  ]);
  await redisCommand(["EXPIRE", key, RETENTION_SECONDS]);
  return entry;
}

export async function removeSchoolKid(id: string, date = todayIST()): Promise<void> {
  await redisCommand(["HDEL", keyFor(date), id]);
}
