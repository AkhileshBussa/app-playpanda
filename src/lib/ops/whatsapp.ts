/**
 * The "your time is up" WhatsApp nudge.
 *
 * When a session's clock runs out, someone has to walk the play area and find
 * the parent. On a busy evening that's the slowest part of a checkout, and the
 * conversation is the same every time: time's finished, come to the counter, and
 * if you want longer the manager can add it.
 *
 * So the card offers to send it instead. This builds a wa.me link with the
 * message pre-typed; the manager taps, WhatsApp opens on the tablet with the
 * chat and text ready, and they press send. Deliberately NOT automatic — nothing
 * leaves the tablet without a human tap in WhatsApp itself.
 *
 * Offered only once the clock has actually run out, so there's exactly one
 * wording and it's always true when it lands.
 */

import { normalizePhone } from "@/lib/members/types";
import type { OpsSession } from "@/lib/ops/types";

/** India, the only place these numbers come from. */
const COUNTRY_CODE = "91";

/**
 * `phone` as WhatsApp wants it (country code, digits only), or null when it
 * isn't a number we can open a chat with — manual visits and older invoices
 * sometimes carry a blank or a landline.
 */
export function whatsappNumber(phone: string): string | null {
  const local = normalizePhone(phone);
  return /^\d{10}$/.test(local) ? COUNTRY_CODE + local : null;
}

/**
 * What the manager will be shown, ready to send.
 *
 * Greets the recipient as "Parent" rather than by name — the name on an invoice
 * is whoever booked and paid, which is often not the person holding the phone,
 * and getting it wrong is worse than not using one.
 *
 * The kids are still named, because a parent with two kids in on separate
 * bookings gets one of these per booking and needs to know which just ended.
 */
export function timeUpMessage(session: OpsSession): string {
  const who = session.kidNames.length > 0 ? session.kidNames.join(" & ") : "your kids";
  return [
    `Hi Parent, ${who}'s play time at Play Panda is finished. 🐼`,
    "",
    "Please come to the counter whenever you're ready to head out. If you'd like to extend the session, just let the manager know and we'll add more time.",
    "",
    "Thank you!",
  ].join("\n");
}

/** The wa.me link that opens this chat with the message typed in, or null when
 *  the session has no number worth dialling. */
export function timeUpWhatsappLink(session: OpsSession): string | null {
  const number = whatsappNumber(session.phone);
  if (!number) return null;
  return `https://wa.me/${number}?text=${encodeURIComponent(timeUpMessage(session))}`;
}
