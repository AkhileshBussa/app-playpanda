/**
 * Weekend wristband colors.
 *
 * Saturday and Sunday, 4pm–9pm, the floor is too busy to read timers card by
 * card. So every session's wristband gets stamped with the color of the half
 * hour it has to be out by, and staff sweep the play area looking for one
 * color instead of chasing names.
 *
 * Two rules keep the colors in muscle memory:
 *
 * 1. The mapping is fixed to the clock, never to arrival order — the 6:30 band
 *    is purple this Saturday, next Saturday, and every Saturday after.
 * 2. Six colors cover a 3-hour cycle, so by the time a color comes back around
 *    (4:30 and 7:30 are both coral) that band's kids left long ago.
 *
 * Times are the device's local clock, like every other time on the monitor —
 * the counter tablet runs on IST.
 */

export type BandColor = "coral" | "yellow" | "green" | "teal" | "purple" | "pink";

/** Saturday and Sunday, as `Date#getDay` numbers them. */
const BAND_DAYS = [0, 6];

export const BAND_WINDOW_START_HOUR = 16;
export const BAND_WINDOW_END_HOUR = 21;
const SLOT_MINUTES = 30;

/** Palette colors that stay apart at a glance — brown reads as coral under the
 *  play-area lights, and cream/ink can't be stamped. Order sets the cycle. */
const BAND_CYCLE: BandColor[] = ["coral", "yellow", "green", "teal", "purple", "pink"];

const BAND_CHIP: Record<BandColor, string> = {
  coral: "bg-coral text-cream",
  yellow: "bg-yellow text-ink",
  green: "bg-green text-cream",
  teal: "bg-teal text-ink",
  purple: "bg-purple text-cream",
  pink: "bg-pink text-ink",
};

export interface WristBand {
  color: BandColor;
  /** What staff call it out loud: "Coral". */
  label: string;
  /** End of this band's half hour, e.g. "6:30 PM" — everyone wearing it is out by then. */
  outBy: string;
  /** `outBy` without the meridiem, for the legend where every band is a PM one. */
  outByShort: string;
  /** Tailwind background + text classes for a filled swatch. */
  chip: string;
}

const SLOT_COUNT = ((BAND_WINDOW_END_HOUR - BAND_WINDOW_START_HOUR) * 60) / SLOT_MINUTES;

function formatSlotTime(minutesOfDay: number): string {
  const h24 = Math.floor(minutesOfDay / 60);
  const minutes = minutesOfDay % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(minutes).padStart(2, "0")} ${h24 < 12 ? "AM" : "PM"}`;
}

/** Every band of the rush, earliest first — the lookup table and the legend. */
export const BAND_SLOTS: WristBand[] = Array.from({ length: SLOT_COUNT }, (_, slot) => {
  const color = BAND_CYCLE[slot % BAND_CYCLE.length];
  const outByMinutes = BAND_WINDOW_START_HOUR * 60 + (slot + 1) * SLOT_MINUTES;
  return {
    color,
    label: color.charAt(0).toUpperCase() + color.slice(1),
    outBy: formatSlotTime(outByMinutes),
    outByShort: formatSlotTime(outByMinutes).replace(/ [AP]M$/, ""),
    chip: BAND_CHIP[color],
  };
});

/** True on a weekend inside the 4pm–9pm rush (local clock). */
export function isBandWindow(at: number): boolean {
  const d = new Date(at);
  if (!BAND_DAYS.includes(d.getDay())) return false;
  return d.getHours() >= BAND_WINDOW_START_HOUR && d.getHours() < BAND_WINDOW_END_HOUR;
}

/**
 * The wristband for a session ending at `end`, or null when that time falls
 * outside the weekend rush (and on sessions with no end time at all — untimed
 * membership visits, and app bookings still waiting to check in).
 */
export function bandForEnd(end: number | null): WristBand | null {
  if (end == null) return null;
  const d = new Date(end);
  if (!BAND_DAYS.includes(d.getDay())) return null;

  // Seconds count: an end time of 9:00:30 PM is past closing, not on the last band.
  const minutes = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  const windowStart = BAND_WINDOW_START_HOUR * 60;
  const windowEnd = BAND_WINDOW_END_HOUR * 60;
  if (minutes < windowStart || minutes > windowEnd) return null;

  // The band is the first half-hour mark this session is out BY, so round the
  // end time up to a mark and take the slot that carries it.
  //
  // Rounding down instead puts a session that ends exactly on a mark into the
  // following band: a 4:30 finish came out as "out by 5:00 PM" printed directly
  // above a timer reading 4:30, which is the card disagreeing with itself.
  //
  // The clamps cover the two ends: a finish exactly at 4:00 has no earlier mark
  // to belong to, and one at 9:00 shares the last band rather than falling off
  // the end of the table.
  const slot = Math.min(
    Math.max(Math.ceil((minutes - windowStart) / SLOT_MINUTES) - 1, 0),
    SLOT_COUNT - 1
  );
  return BAND_SLOTS[slot];
}
