/**
 * "How did you hear about us?" — the optional one-tap question first-time
 * families see on the booking form. Shared by the form (the checkboxes) and
 * /api/checkout (validation), so the two can't drift apart.
 */
export const HEARD_FROM_SOURCES = [
  "Instagram",
  "Google",
  "Friends & family",
  "WhatsApp group",
  "Walked past",
  "School / event",
] as const;

export type HeardFromSource = (typeof HEARD_FROM_SOURCES)[number];
