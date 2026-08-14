-- Drop every app table so the schema in src/lib/db/schema.ts recreates
-- everything fresh on the next request. ONE-TIME, DESTRUCTIVE — meant for the
-- cutover to the consolidated schema (nothing was in production use), not for
-- day-to-day operations.
--
--   psql "$DATABASE_URL" -f scripts/db-reset.sql
--
-- Covers both the old per-module tables (heard_from included) and the new
-- names, so it's safe to run against either shape.

BEGIN;

-- New + shared tables (order irrelevant with CASCADE, listed leaf-first anyway)
DROP TABLE IF EXISTS discount_redemptions CASCADE;
DROP TABLE IF EXISTS discount_codes CASCADE;
DROP TABLE IF EXISTS membership_visits CASCADE;
DROP TABLE IF EXISTS memberships CASCADE;
DROP TABLE IF EXISTS payments CASCADE;
DROP TABLE IF EXISTS invoice_items CASCADE;
DROP TABLE IF EXISTS invoices CASCADE;
DROP TABLE IF EXISTS products CASCADE;
DROP TABLE IF EXISTS customers CASCADE;

-- Staff tools
DROP TABLE IF EXISTS attendance CASCADE;
DROP TABLE IF EXISTS leave_requests CASCADE;
DROP TABLE IF EXISTS maintenance_issues CASCADE;
DROP TABLE IF EXISTS feedback CASCADE;
DROP TABLE IF EXISTS employees CASCADE;

-- Retired: merged into customers
DROP TABLE IF EXISTS heard_from CASCADE;

COMMIT;
