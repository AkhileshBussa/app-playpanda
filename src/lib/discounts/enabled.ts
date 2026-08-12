/**
 * Kill switch for the CUSTOMER-facing half of discounts.
 *
 * `NEXT_PUBLIC_DISCOUNT_CODES_ENABLED="true"` puts the code box on the booking
 * form and lets /api/checkout honour a typed code. Anything else — unset
 * included — and self-checkout behaves as if codes don't exist.
 *
 * Deliberately opt-IN, unlike NEXT_PUBLIC_PAYMENTS_ENABLED's opt-out: handing
 * customers a code box is a decision to start running an offer, and a deploy
 * shouldn't make that decision by accident.
 *
 * The COUNTER side is never gated by this. Staff discounting an invoice at the
 * desk is the thing that already happens every week (it just happened in Swipe
 * by hand), so /ops keeps working whatever this is set to — including applying
 * a code that customers can't yet type themselves.
 *
 * NEXT_PUBLIC_ is inlined at build time, so changing it needs a rebuild/redeploy.
 */
export const CUSTOMER_CODES_ENABLED = process.env.NEXT_PUBLIC_DISCOUNT_CODES_ENABLED === "true";
