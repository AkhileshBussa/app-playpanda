/**
 * Device-local booking profile — the "don't make them type it twice" store.
 *
 * A family that scans the QR is on their own phone, so after a successful
 * booking their contact details are kept in localStorage and restored the
 * next time the form loads. This is a convenience cache, not a record: the
 * durable customer lives in Postgres (lib/customers), and the server lookup
 * still runs on restore, so anything stale gets refreshed from the backend.
 *
 * Everything is wrapped in try/catch because storage can be unavailable
 * (private browsing, storage-full, embedded webviews) — losing the nicety
 * must never break booking.
 */

const KEY = "pp:profile:v1";

export interface SavedProfile {
  phone: string;
  name: string;
  /** Comma-separated, same format the form field holds. */
  kidNames: string;
  savedAt: number;
}

export function loadProfile(): SavedProfile | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<SavedProfile>;
    if (typeof p.phone !== "string" || !/^[6-9]\d{9}$/.test(p.phone)) return null;
    return {
      phone: p.phone,
      name: typeof p.name === "string" ? p.name : "",
      kidNames: typeof p.kidNames === "string" ? p.kidNames : "",
      savedAt: typeof p.savedAt === "number" ? p.savedAt : 0,
    };
  } catch {
    return null;
  }
}

export function saveProfile(p: { phone: string; name: string; kidNames: string }): void {
  try {
    const profile: SavedProfile = { ...p, savedAt: Date.now() };
    localStorage.setItem(KEY, JSON.stringify(profile));
  } catch {
    // storage unavailable — the booking itself is unaffected
  }
}

export function clearProfile(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing to do
  }
}
