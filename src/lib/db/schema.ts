/**
 * The whole database in one schema block.
 *
 * One block, deliberately: customers and invoices are referenced from every
 * module, and real foreign keys only work if a single piece of DDL owns the
 * creation order. (The old per-module blocks couldn't reference each other's
 * tables — whichever feature was touched first on a cold start decided
 * whether the DDL succeeded.)
 *
 * Conventions:
 *  - TEXT uuid primary keys.
 *  - Instants are TIMESTAMPTZ (DEFAULT now() on insert); true calendar days
 *    (expiry, attendance) are DATE — read back as "YYYY-MM-DD" strings via the
 *    parser in ../pg.ts. Wire types keep exposing unix ms; see ms()/msOrNull.
 *  - Every table has last_updated_at, maintained in application SQL: inserts
 *    take the default, every UPDATE must also SET last_updated_at = now().
 *  - Every table has a metadata JSONB for whatever the future needs, so
 *    "one more field" doesn't mean a migration.
 *  - Swipe handles live ONLY in swipe_ref columns (customers = party id,
 *    products = product id, invoices = document hash id). Everything else
 *    references our own ids, so replacing Swipe means writing a new billing
 *    adapter and backfilling three columns — nothing structural.
 */

import { onceSchema } from "../pg";

export const ensureSchema = onceSchema(`
  -- ── Customers ──────────────────────────────────────────────────────────────
  -- One row per family, keyed by phone. "How did you hear about us?" lives
  -- here (asked once, on the first booking) rather than in its own log table.
  CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    phone TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    kid_names TEXT NOT NULL DEFAULT '',
    heard_from_sources TEXT NOT NULL DEFAULT '',
    heard_from_at TIMESTAMPTZ,
    swipe_ref TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata JSONB NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS customers_created_idx ON customers (created_at);

  -- ── Products ───────────────────────────────────────────────────────────────
  -- Our own catalogue rows, upserted from code (pricing.ts, members/plans.ts)
  -- the first time each product lands on an invoice. swipe_ref is the Swipe
  -- product id and the natural key.
  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'other',
    item_type TEXT NOT NULL DEFAULT 'Product',
    price_inr NUMERIC,
    tax_rate_percent NUMERIC NOT NULL DEFAULT 0,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    swipe_ref TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata JSONB NOT NULL DEFAULT '{}'
  );

  -- ── Invoices ───────────────────────────────────────────────────────────────
  -- Durable mirror of every invoice the app creates (Swipe stays the books of
  -- record for GST; this is our own ledger and history). The session lifecycle
  -- stamps (check-in/out, removal) live here too — an invoice is 1:1 with a
  -- board session, and Redis only keeps the day's fast path.
  -- number is deliberately NOT unique: Swipe reissues a serial after the
  -- document holding it is deleted (seen live with INV-1913, 2026-08-15), so
  -- two different invoices can wear the same number over time. The doc hash
  -- (swipe_ref) is the identity; number-based lookups prefer the newest
  -- non-cancelled row.
  CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY,
    number TEXT NOT NULL,
    customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
    source TEXT NOT NULL DEFAULT 'app',
    status TEXT NOT NULL DEFAULT 'unpaid',
    gross_inr NUMERIC NOT NULL DEFAULT 0,
    discount_inr NUMERIC NOT NULL DEFAULT 0,
    net_inr NUMERIC NOT NULL DEFAULT 0,
    amount_paid_inr NUMERIC NOT NULL DEFAULT 0,
    issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    checkin_at TIMESTAMPTZ,
    checkout_at TIMESTAMPTZ,
    removed_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    environment TEXT NOT NULL DEFAULT 'local',
    swipe_ref TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata JSONB NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS invoices_customer_idx ON invoices (customer_id);
  CREATE INDEX IF NOT EXISTS invoices_issued_idx ON invoices (issued_at);
  CREATE INDEX IF NOT EXISTS invoices_number_idx ON invoices (number);
  CREATE INDEX IF NOT EXISTS invoices_environment_idx ON invoices (environment);
  CREATE UNIQUE INDEX IF NOT EXISTS invoices_swipe_ref_uidx
    ON invoices (swipe_ref) WHERE swipe_ref IS NOT NULL;
  -- The online payment flow finds its invoice by gateway order id (stored in
  -- metadata at order creation) — indexed so the verify path stays a lookup.
  CREATE INDEX IF NOT EXISTS invoices_rzp_order_idx ON invoices ((metadata->>'rzp_order_id'));

  -- A paid-online booking BEFORE its invoice exists. The online flow creates
  -- no invoice until Razorpay confirms the money (a failed or abandoned
  -- payment must leave nothing behind in Swipe), so the booking details wait
  -- here, keyed by the gateway order. Consumed exactly once — the status flip
  -- is the claim that decides whether browser-confirm or the webhook builds
  -- the invoice. Abandoned rows just age out harmlessly.
  CREATE TABLE IF NOT EXISTS pending_bookings (
    id TEXT PRIMARY KEY,
    rzp_order_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending',
    payload JSONB NOT NULL,
    environment TEXT NOT NULL DEFAULT 'local',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata JSONB NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS pending_bookings_created_idx ON pending_bookings (created_at);

  CREATE TABLE IF NOT EXISTS invoice_items (
    id TEXT PRIMARY KEY,
    invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    quantity NUMERIC NOT NULL,
    unit_price_inr NUMERIC NOT NULL,
    tax_rate_percent NUMERIC NOT NULL DEFAULT 0,
    total_inr NUMERIC NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata JSONB NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS invoice_items_invoice_idx ON invoice_items (invoice_id);
  CREATE INDEX IF NOT EXISTS invoice_items_product_idx ON invoice_items (product_id);

  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    amount_inr NUMERIC NOT NULL,
    method TEXT NOT NULL,
    transaction_ref TEXT NOT NULL DEFAULT '',
    rzp_order_id TEXT NOT NULL DEFAULT '',
    rzp_payment_id TEXT NOT NULL DEFAULT '',
    paid_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata JSONB NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS payments_invoice_idx ON payments (invoice_id);
  CREATE INDEX IF NOT EXISTS payments_paid_idx ON payments (paid_at);
  -- One mirror row per gateway payment, however many delivery paths fire
  -- (browser confirm + webhook race for the same payment id).
  CREATE UNIQUE INDEX IF NOT EXISTS payments_rzp_payment_idx
    ON payments (rzp_payment_id) WHERE rzp_payment_id <> '';

  -- ── Memberships ────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS memberships (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES customers(id),
    product_id TEXT NOT NULL REFERENCES products(id),
    sale_invoice_id TEXT REFERENCES invoices(id) ON DELETE SET NULL,
    plan_key TEXT NOT NULL,
    plan_name TEXT NOT NULL,
    kid_names TEXT NOT NULL DEFAULT '',
    total_plays INTEGER,
    hours_per_play DOUBLE PRECISION NOT NULL,
    kids_per_play INTEGER NOT NULL DEFAULT 1,
    price_inr NUMERIC,
    weekdays_only BOOLEAN NOT NULL DEFAULT FALSE,
    once_per_day BOOLEAN NOT NULL DEFAULT FALSE,
    starts_on DATE NOT NULL,
    expires_on DATE NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    deleted_at TIMESTAMPTZ,
    deleted_reason TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata JSONB NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS memberships_customer_idx ON memberships (customer_id);
  CREATE INDEX IF NOT EXISTS memberships_starts_idx ON memberships (starts_on);
  CREATE INDEX IF NOT EXISTS memberships_expires_idx ON memberships (expires_on);

  CREATE TABLE IF NOT EXISTS membership_visits (
    id TEXT PRIMARY KEY,
    membership_id TEXT NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
    punch_invoice_id TEXT REFERENCES invoices(id) ON DELETE SET NULL,
    kids_count INTEGER NOT NULL,
    plays_used INTEGER NOT NULL,
    kid_names TEXT NOT NULL DEFAULT '',
    visited_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    deleted_reason TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata JSONB NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS membership_visits_membership_idx
    ON membership_visits (membership_id);
  -- The once-per-day rule and the day views group by IST day; visited_at is
  -- the only stored field, so index the derived day.
  CREATE INDEX IF NOT EXISTS membership_visits_ist_day_idx
    ON membership_visits (((visited_at AT TIME ZONE 'Asia/Kolkata')::date));

  -- ── Staff tools ────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS employees (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'staff',
    pin_hash TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata JSONB NOT NULL DEFAULT '{}'
  );

  -- One row per employee per IST day; the unique index is what stops a double
  -- check-in when two taps race.
  CREATE TABLE IF NOT EXISTS attendance (
    id TEXT PRIMARY KEY,
    employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    work_date DATE NOT NULL,
    checkin_at TIMESTAMPTZ NOT NULL,
    checkin_lat DOUBLE PRECISION NOT NULL,
    checkin_lng DOUBLE PRECISION NOT NULL,
    checkin_accuracy_m DOUBLE PRECISION NOT NULL,
    checkin_distance_m DOUBLE PRECISION,
    checkout_at TIMESTAMPTZ,
    checkout_lat DOUBLE PRECISION,
    checkout_lng DOUBLE PRECISION,
    checkout_accuracy_m DOUBLE PRECISION,
    checkout_distance_m DOUBLE PRECISION,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata JSONB NOT NULL DEFAULT '{}'
  );
  CREATE UNIQUE INDEX IF NOT EXISTS attendance_employee_day_idx
    ON attendance (employee_id, work_date);
  CREATE INDEX IF NOT EXISTS attendance_day_idx ON attendance (work_date);

  CREATE TABLE IF NOT EXISTS leave_requests (
    id TEXT PRIMARY KEY,
    employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    from_date DATE NOT NULL,
    to_date DATE NOT NULL,
    leave_type TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    decided_by TEXT NOT NULL DEFAULT '',
    decided_at TIMESTAMPTZ,
    decision_note TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata JSONB NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS leave_employee_idx ON leave_requests (employee_id);
  CREATE INDEX IF NOT EXISTS leave_range_idx ON leave_requests (from_date, to_date);

  CREATE TABLE IF NOT EXISTS maintenance_issues (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL DEFAULT 'normal',
    status TEXT NOT NULL DEFAULT 'open',
    photo_url TEXT NOT NULL DEFAULT '',
    reported_by_name TEXT NOT NULL DEFAULT '',
    resolved_at TIMESTAMPTZ,
    resolution_note TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata JSONB NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS issues_status_idx ON maintenance_issues (status);

  CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY,
    rating INTEGER NOT NULL,
    improve TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    sent_to_google BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata JSONB NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS feedback_created_idx ON feedback (created_at);

  -- ── Discounts ──────────────────────────────────────────────────────────────
  -- Postgres is the ledger of record here (Swipe can't answer "is this code
  -- burnt?"). Names are stored alongside ids on purpose: the ledger must stay
  -- readable even when a roster row is deactivated or a customer is unknown.
  CREATE TABLE IF NOT EXISTS discount_codes (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    kind TEXT NOT NULL,
    value NUMERIC NOT NULL,
    max_discount NUMERIC,
    min_order NUMERIC NOT NULL DEFAULT 0,
    usage TEXT NOT NULL DEFAULT 'multi',
    per_customer_limit INTEGER,
    total_limit INTEGER,
    starts_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    channels TEXT NOT NULL DEFAULT 'online,counter',
    note TEXT NOT NULL DEFAULT '',
    created_by_employee_id TEXT REFERENCES employees(id) ON DELETE SET NULL,
    created_by_name TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata JSONB NOT NULL DEFAULT '{}'
  );
  CREATE UNIQUE INDEX IF NOT EXISTS discount_codes_code_idx
    ON discount_codes (upper(code));

  CREATE TABLE IF NOT EXISTS discount_redemptions (
    id TEXT PRIMARY KEY,
    code_id TEXT REFERENCES discount_codes(id) ON DELETE SET NULL,
    code TEXT NOT NULL,
    customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
    customer_name TEXT NOT NULL DEFAULT '',
    invoice_id TEXT REFERENCES invoices(id) ON DELETE SET NULL,
    gross_inr NUMERIC NOT NULL,
    discount_inr NUMERIC NOT NULL,
    net_inr NUMERIC NOT NULL,
    channel TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'applied',
    rzp_order_id TEXT NOT NULL DEFAULT '',
    rzp_payment_id TEXT NOT NULL DEFAULT '',
    applied_by_employee_id TEXT REFERENCES employees(id) ON DELETE SET NULL,
    applied_by_name TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata JSONB NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS discount_redemptions_code_idx
    ON discount_redemptions (code_id);
  CREATE INDEX IF NOT EXISTS discount_redemptions_customer_idx
    ON discount_redemptions (code_id, customer_id);
  CREATE INDEX IF NOT EXISTS discount_redemptions_invoice_idx
    ON discount_redemptions (invoice_id);
  CREATE INDEX IF NOT EXISTS discount_redemptions_created_idx
    ON discount_redemptions (created_at);
  CREATE INDEX IF NOT EXISTS discount_redemptions_rzp_order_idx
    ON discount_redemptions (rzp_order_id);

  -- ── Cash ledger ────────────────────────────────────────────────────────────
  -- What the counter counted, so the owner can tell how much cash is actually
  -- in the store. Nothing here comes from Swipe: these are the DECLARED
  -- figures, kept deliberately independent of the books so the two can be put
  -- side by side and disagree. (The Swipe side of the tally, and cash spent
  -- from the drawer, are read live from Swipe — never copied in here.)
  --
  -- Amounts are stamped with the environment for the same reason invoices are:
  -- one Neon database serves prod, preview and local, and a test entry must
  -- never move the real drawer.
  CREATE TABLE IF NOT EXISTS cash_months (
    month TEXT NOT NULL,
    environment TEXT NOT NULL DEFAULT 'local',
    opening_inr NUMERIC NOT NULL DEFAULT 0,
    -- The first day the ledger covers. Set only for the month the ledger was
    -- switched on mid-way (September 2026 starts on the 6th); NULL means the
    -- whole month counts.
    starts_on DATE,
    -- TRUE when a human set this opening; FALSE when it was carried forward
    -- from the previous month's close. Carried openings re-derive, set ones
    -- never move under the owner's feet.
    is_explicit BOOLEAN NOT NULL DEFAULT FALSE,
    set_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata JSONB NOT NULL DEFAULT '{}',
    PRIMARY KEY (month, environment)
  );

  CREATE TABLE IF NOT EXISTS cash_days (
    id TEXT PRIMARY KEY,
    day DATE NOT NULL,
    environment TEXT NOT NULL DEFAULT 'local',
    declared_cash_inr NUMERIC NOT NULL DEFAULT 0,
    declared_online_inr NUMERIC NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    entered_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata JSONB NOT NULL DEFAULT '{}'
  );
  -- One declaration per day: entering it again corrects it rather than adding
  -- a second day's takings.
  CREATE UNIQUE INDEX IF NOT EXISTS cash_days_day_idx ON cash_days (day, environment);

  -- Cash that moved for a reason that isn't a sale or an expense — the owner
  -- taking money out, or float going in. Always a positive amount; the
  -- direction column says which way.
  CREATE TABLE IF NOT EXISTS cash_movements (
    id TEXT PRIMARY KEY,
    day DATE NOT NULL,
    environment TEXT NOT NULL DEFAULT 'local',
    direction TEXT NOT NULL,
    amount_inr NUMERIC NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    party TEXT NOT NULL DEFAULT '',
    recorded_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata JSONB NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS cash_movements_day_idx ON cash_movements (day, environment);

  -- Every human change to the ledger, append-only. Nothing ever updates or
  -- deletes a row here: a figure that can be corrected quietly is not a
  -- ledger, and the correction is often the interesting part.
  --
  -- Two names on each row, deliberately. changed_by is typed on the form and
  -- is therefore a claim; changed_tier comes from the cookie that was actually
  -- presented and cannot be typed at all. When they disagree, believe the tier.
  --
  -- Carried-forward opening balances are NOT recorded: they're derived from
  -- the previous month's close and re-derived on every read, so logging them
  -- would bury the handful of real edits under machine noise.
  CREATE TABLE IF NOT EXISTS cash_audit (
    id TEXT PRIMARY KEY,
    environment TEXT NOT NULL DEFAULT 'local',
    -- The ledger day the change is ABOUT, not the day it was made — that's
    -- created_at. This is what hangs the history off the right day's card.
    day DATE NOT NULL,
    entity TEXT NOT NULL,
    action TEXT NOT NULL,
    before JSONB,
    after JSONB,
    changed_by TEXT NOT NULL DEFAULT '',
    changed_tier TEXT NOT NULL DEFAULT 'counter',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Present for the schema convention's sake; on an append-only table it
    -- never moves off created_at.
    last_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata JSONB NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS cash_audit_day_idx ON cash_audit (day, environment);
`);

// ── Row helpers ──────────────────────────────────────────────────────────────
// Wire types keep speaking unix ms (what every component and route already
// consumes); TIMESTAMPTZ columns come back from pg as JS Dates.

/* eslint-disable @typescript-eslint/no-explicit-any */

/** TIMESTAMPTZ column → unix ms. */
export function ms(v: any): number {
  if (v == null) return 0;
  if (v instanceof Date) return v.getTime();
  const t = new Date(v).getTime();
  return isNaN(t) ? 0 : t;
}

/** Nullable TIMESTAMPTZ column → unix ms or null. */
export function msOrNull(v: any): number | null {
  return v == null ? null : ms(v);
}

/* eslint-enable @typescript-eslint/no-explicit-any */

/** SQL expression for a TIMESTAMPTZ parameter passed as unix ms. */
export const TS = (param: string) => `to_timestamp(${param}::double precision / 1000.0)`;

/**
 * Which deployment wrote the row — stamped on invoices so prod, preview, dev
 * and local test data can be told apart (they share one Neon database). Also
 * scopes number-based invoice lookups: a serial from a local test must never
 * catch a prod payment, or vice versa.
 */
export function appEnvironment(): "prod" | "preview" | "dev" | "local" {
  switch (process.env.VERCEL_ENV) {
    case "production":
      return "prod";
    case "preview":
      return "preview";
    case "development":
      return "dev";
    default:
      return "local";
  }
}
