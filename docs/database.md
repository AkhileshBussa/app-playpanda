# The database

One Postgres (Neon via Vercel Marketplace; any `DATABASE_URL` works), one
schema block: [`src/lib/db/schema.ts`](../src/lib/db/schema.ts). Every table is
created idempotently on first use — installing the database is the only
migration step. For the one-time cutover from the old per-module tables, run:

```bash
psql "$DATABASE_URL" -f scripts/db-reset.sql
```

## What lives where

Swipe remains the books of record (GST, printed invoices). Postgres is **our**
ledger — the thing that can answer "how often does this family visit", "how
many sock pairs did we sell", "which code paid for itself" without scanning a
third party's API.

| Table | What it holds |
| --- | --- |
| `customers` | One row per family, keyed by phone. Kid names, plus the "how did you hear about us?" answer (asked once, on the first booking). |
| `products` | Our catalogue rows, upserted lazily from code (`pricing.ts`, `members/plans.ts`) the first time each product is billed. |
| `invoices` | Mirror of every invoice the app creates (`app` / `counter` / `membership_punch` / `external`), with totals, status, the session lifecycle stamps (check-in/out, removal, cancellation), and the `environment` that wrote it (`prod` / `preview` / `dev` / `local`) so test rows never mix into prod analysis. |
| `invoice_items` | One row per billed line, referencing `products`. |
| `pending_bookings` | Pay-first online bookings waiting for their money: the priced payload keyed by Razorpay order id. Consumed (once) when the payment captures and the real invoice is built; abandoned rows age out harmlessly — nothing ever reaches Swipe for an unpaid online booking. |
| `payments` | One row per payment (counter + gateway), referencing `invoices`. |
| `memberships`, `membership_visits` | Source of truth for passes and punches (Swipe's ₹0 punch invoices are receipts). |
| `discount_codes`, `discount_redemptions` | Ledger of record for discounts — limits are enforced here, nowhere else. |
| `employees`, `attendance`, `leave_requests`, `maintenance_issues`, `feedback` | The staff tools. |
| `cash_months`, `cash_days`, `cash_movements` | The cash ledger — the month's opening balance, what the counter counted each day, and cash moving for reasons that aren't sales. Only the *declared* side lives here; the Swipe tally and cash spent on expenses are read live (see [ledger.md](./ledger.md)). |
| `cash_audit` | Append-only history of every human change to the three tables above. Written in the same transaction as the change it describes, so no path can alter a figure without leaving a trace. Nothing updates or deletes rows here. |
| `vendors` | Suppliers added through this app, so the purchase form can offer one before it has any purchases. Not a mirror of Swipe's vendors — Swipe has no endpoint that lists them (see [inventory.md](./inventory.md)). |
| `product_audit` | Append-only history of catalogue changes — price, cost, reorder level — with who made each. The products live in Swipe, which keeps no history of its own; this is the record (see [inventory.md](./inventory.md)). |

## Conventions

- TEXT uuid primary keys; cross-table references are real foreign keys to OUR
  ids — never phone numbers, never Swipe handles.
- Instants are `TIMESTAMPTZ`; true calendar days (expiry, attendance) are
  `DATE`, read back as `YYYY-MM-DD` strings (parser in `src/lib/pg.ts`). Wire
  types still speak unix ms — mappers convert at the edge.
- Every table has `last_updated_at` (set by application SQL: every `UPDATE`
  includes `last_updated_at = now()`) and a `metadata JSONB` for future fields.
- **Swipe handles live in exactly three columns**: `customers.swipe_ref`
  (party id), `products.swipe_ref` (product id), `invoices.swipe_ref`
  (document hash id). Replacing Swipe = a new `BillingProvider` adapter
  (`src/lib/billing/`) + backfilling those columns. Nothing else changes.
- **Invoice numbers are not unique over time.** Swipe reissues a serial after
  the document holding it is deleted (observed live: INV-1913, 2026-08-15),
  so `invoices.number` is a plain indexed column and identity rides on
  `swipe_ref` (unique). Number-based lookups resolve to the current
  environment's newest non-cancelled row.

## Mirror-write contract

Booking, payment and punch flows write Swipe first, then mirror here
**best-effort**: a Postgres failure is logged and never fails the customer
flow. The exceptions are the tables that are themselves the source of truth
(memberships, discounts) — those fail loudly, as before.
