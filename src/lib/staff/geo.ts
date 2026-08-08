/**
 * Attendance geofence. Employees mark themselves in from the playzone, so the
 * server re-checks the browser's coordinates against the playzone before
 * accepting the entry — the client can't be trusted to enforce its own rule.
 *
 * The location is hardcoded, not configuration. There is one Play Panda, its
 * coordinates don't change, and making it an env var only created a way to
 * forget it — which silently disabled the whole check. If the playzone ever
 * moves, edit PLAYZONE below.
 */

/**
 * Play Panda, Hyderabad. Taken from the Google Maps **place pin**
 * (`!3d17.3582013!4d78.3881378`), not the map centre in the same URL — those
 * sit 74 m apart, which would eat half the radius.
 */
export const PLAYZONE = {
  lat: 17.3582013,
  lng: 78.3881378,
  /** How far from the pin still counts as "at the playzone". */
  radiusM: 150,
} as const;

/**
 * Browsers report a 68%-confidence accuracy radius, and indoor GPS is bad. A
 * fix is judged by how close it *could* be, so a phone that says "within 400 m
 * of a point 300 m away" is let through rather than punished for poor signal.
 */
export const MAX_ACCURACY_M = 2000;

/** Great-circle distance between two points, metres. */
export function distanceMeters(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number
): number {
  const R = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Metres from the playzone. */
export function distanceFromPlayzone(lat: number, lng: number): number {
  return Math.round(distanceMeters(PLAYZONE.lat, PLAYZONE.lng, lat, lng));
}

export interface FenceVerdict {
  ok: boolean;
  distanceM: number;
  /** Why it was rejected — safe to show the employee. */
  error: string | null;
}

export function checkFence(fix: {
  lat: number;
  lng: number;
  accuracyM: number;
}): FenceVerdict {
  const distanceM = distanceFromPlayzone(fix.lat, fix.lng);

  // A wildly imprecise fix proves nothing either way; rejecting it is the
  // honest call, and the message tells the employee what to do about it.
  if (fix.accuracyM > MAX_ACCURACY_M) {
    return {
      ok: false,
      distanceM,
      error: "Your location is too imprecise. Step near a window or outside and try again.",
    };
  }

  if (distanceM - fix.accuracyM > PLAYZONE.radiusM) {
    return {
      ok: false,
      distanceM,
      error: `You're about ${formatDistance(distanceM)} from Play Panda — attendance can only be marked at the playzone.`,
    };
  }

  return { ok: true, distanceM, error: null };
}

export function formatDistance(metres: number): string {
  return metres < 1000 ? `${metres} m` : `${(metres / 1000).toFixed(1)} km`;
}
