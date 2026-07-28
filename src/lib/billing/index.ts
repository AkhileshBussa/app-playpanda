/**
 * Active billing backend. This is the ONE place to swap providers.
 *
 * To move off Swipe: write a new adapter that implements BillingProvider
 * (see ./types.ts) — e.g. `./ourBackend.ts` — and change the assignment below.
 * Everything else (routes, UI) depends only on the `billing` interface and
 * won't need to change.
 */

import type { BillingProvider } from "./types";
import { swipeBilling } from "./swipe";

export const billing: BillingProvider = swipeBilling;

export * from "./types";
