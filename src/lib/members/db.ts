/**
 * Membership store — Postgres (Neon via Vercel Marketplace; any DATABASE_URL
 * works). This is the durable source of truth for memberships and visits; the
 * Google Sheet (./sheets.ts) is a best-effort mirror for easy viewing.
 *
 * Dates are stored as YYYY-MM-DD TEXT (IST day, lexicographically comparable)
 * and instants as BIGINT unix ms — same shapes the rest of the app uses, and
 * they round-trip through pg without date-parsing surprises.
 */

import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import type { Membership, MembershipVisit } from "./types";

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("Postgres not configured — set DATABASE_URL");
    pool = new Pool({
      connectionString: url,
      max: 3,
      // Neon (and other hosted Postgres) require TLS; local dev doesn't run it.
      ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: true },
    });
  }
  return pool;
}

export function membersDbConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

// Schema is tiny and idempotent — ensure it once per process instead of
// requiring a migration step beyond installing the database.
let schemaReady: Promise<void> | null = null;

function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await getPool().query(`
        CREATE TABLE IF NOT EXISTS memberships (
          id TEXT PRIMARY KEY,
          phone TEXT NOT NULL,
          customer_name TEXT NOT NULL,
          kid_names TEXT NOT NULL DEFAULT '',
          plan_key TEXT NOT NULL,
          plan_name TEXT NOT NULL,
          punch_product_id INTEGER NOT NULL,
          punch_product_name TEXT NOT NULL,
          total_plays INTEGER,
          hours_per_play DOUBLE PRECISION NOT NULL,
          kids_per_play INTEGER NOT NULL DEFAULT 1,
          price_inr DOUBLE PRECISION,
          sale_invoice_number TEXT NOT NULL DEFAULT '',
          weekdays_only BOOLEAN NOT NULL DEFAULT FALSE,
          once_per_day BOOLEAN NOT NULL DEFAULT FALSE,
          starts_on TEXT NOT NULL,
          expires_on TEXT NOT NULL,
          notes TEXT NOT NULL DEFAULT '',
          created_at BIGINT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS memberships_phone_idx ON memberships (phone);

        CREATE TABLE IF NOT EXISTS membership_visits (
          id TEXT PRIMARY KEY,
          membership_id TEXT NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
          phone TEXT NOT NULL,
          kids_count INTEGER NOT NULL,
          plays_used INTEGER NOT NULL,
          kid_names TEXT NOT NULL DEFAULT '',
          visit_date TEXT NOT NULL,
          punch_invoice_number TEXT NOT NULL DEFAULT '',
          visited_at BIGINT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS membership_visits_membership_idx
          ON membership_visits (membership_id);
        CREATE INDEX IF NOT EXISTS membership_visits_date_idx
          ON membership_visits (visit_date);
      `);
    })().catch((err) => {
      schemaReady = null; // let the next call retry
      throw err;
    });
  }
  return schemaReady;
}

// ── Row mapping ──────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
function toMembership(r: any): Membership {
  return {
    id: r.id,
    phone: r.phone,
    customerName: r.customer_name,
    kidNames: r.kid_names,
    planKey: r.plan_key,
    planName: r.plan_name,
    punchProductId: r.punch_product_id,
    punchProductName: r.punch_product_name,
    totalPlays: r.total_plays,
    hoursPerPlay: r.hours_per_play,
    kidsPerPlay: r.kids_per_play,
    priceInr: r.price_inr,
    saleInvoiceNumber: r.sale_invoice_number,
    weekdaysOnly: r.weekdays_only,
    oncePerDay: r.once_per_day,
    startsOn: r.starts_on,
    expiresOn: r.expires_on,
    notes: r.notes,
    createdAt: Number(r.created_at),
    playsUsed: Number(r.plays_used_total ?? 0),
  };
}

function toVisit(r: any): MembershipVisit {
  return {
    id: r.id,
    membershipId: r.membership_id,
    phone: r.phone,
    kidsCount: r.kids_count,
    playsUsed: r.plays_used,
    kidNames: r.kid_names,
    visitDate: r.visit_date,
    punchInvoiceNumber: r.punch_invoice_number,
    visitedAt: Number(r.visited_at),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const MEMBERSHIP_SELECT = `
  SELECT m.*, COALESCE(v.used, 0) AS plays_used_total
  FROM memberships m
  LEFT JOIN (
    SELECT membership_id, SUM(plays_used) AS used
    FROM membership_visits GROUP BY membership_id
  ) v ON v.membership_id = m.id
`;

// ── Memberships ──────────────────────────────────────────────────────────────

export interface CreateMembershipInput {
  phone: string;
  customerName: string;
  kidNames: string;
  planKey: string;
  planName: string;
  punchProductId: number;
  punchProductName: string;
  totalPlays: number | null;
  hoursPerPlay: number;
  kidsPerPlay: number;
  priceInr: number | null;
  saleInvoiceNumber: string;
  weekdaysOnly: boolean;
  oncePerDay: boolean;
  startsOn: string;
  expiresOn: string;
  notes: string;
}

export async function createMembership(input: CreateMembershipInput): Promise<Membership> {
  await ensureSchema();
  const id = randomUUID();
  const { rows } = await getPool().query(
    `INSERT INTO memberships (
       id, phone, customer_name, kid_names, plan_key, plan_name,
       punch_product_id, punch_product_name, total_plays, hours_per_play,
       kids_per_play, price_inr, sale_invoice_number, weekdays_only,
       once_per_day, starts_on, expires_on, notes, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     RETURNING *, 0 AS plays_used_total`,
    [
      id, input.phone, input.customerName, input.kidNames, input.planKey,
      input.planName, input.punchProductId, input.punchProductName,
      input.totalPlays, input.hoursPerPlay, input.kidsPerPlay, input.priceInr,
      input.saleInvoiceNumber, input.weekdaysOnly, input.oncePerDay,
      input.startsOn, input.expiresOn, input.notes, Date.now(),
    ]
  );
  return toMembership(rows[0]);
}

export async function getMembership(id: string): Promise<Membership | null> {
  await ensureSchema();
  const { rows } = await getPool().query(`${MEMBERSHIP_SELECT} WHERE m.id = $1`, [id]);
  return rows[0] ? toMembership(rows[0]) : null;
}

export async function listMembershipsByPhone(phone: string): Promise<Membership[]> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `${MEMBERSHIP_SELECT} WHERE m.phone = $1 ORDER BY m.created_at DESC`,
    [phone]
  );
  return rows.map(toMembership);
}

export async function listAllMemberships(): Promise<Membership[]> {
  await ensureSchema();
  const { rows } = await getPool().query(`${MEMBERSHIP_SELECT} ORDER BY m.created_at DESC`);
  return rows.map(toMembership);
}

// ── Visits ───────────────────────────────────────────────────────────────────

export async function listVisits(membershipId: string): Promise<MembershipVisit[]> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT * FROM membership_visits WHERE membership_id = $1 ORDER BY visited_at DESC`,
    [membershipId]
  );
  return rows.map(toVisit);
}

export async function listAllVisits(): Promise<MembershipVisit[]> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT * FROM membership_visits ORDER BY visited_at DESC`
  );
  return rows.map(toVisit);
}

/** Visit rejected for a business-rule reason the UI should explain. */
export class VisitError extends Error {
  constructor(readonly code: "not_found" | "expired" | "exhausted" | "already_today", message: string) {
    super(message);
    this.name = "VisitError";
  }
}

export interface RecordVisitInput {
  membershipId: string;
  kidsCount: number;
  playsUsed: number;
  kidNames: string;
  /** Today's IST date — the day the plays are consumed against. */
  visitDate: string;
}

/**
 * Atomically consume plays: locks the membership row, re-checks expiry /
 * remaining plays / once-per-day inside the transaction (so two devices
 * punching at once can't overdraw), then inserts the visit.
 */
export async function recordVisit(
  input: RecordVisitInput
): Promise<{ visit: MembershipVisit; membership: Membership }> {
  await ensureSchema();
  const client: PoolClient = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT * FROM memberships WHERE id = $1 FOR UPDATE`, [
      input.membershipId,
    ]);
    if (!rows[0]) throw new VisitError("not_found", "Membership not found");
    const m = rows[0];

    if (input.visitDate > m.expires_on) {
      throw new VisitError("expired", `This membership expired on ${m.expires_on}`);
    }

    const usedRes = await client.query(
      `SELECT COALESCE(SUM(plays_used), 0) AS used FROM membership_visits WHERE membership_id = $1`,
      [input.membershipId]
    );
    const used = Number(usedRes.rows[0].used);

    if (m.total_plays != null && used + input.playsUsed > m.total_plays) {
      const left = Math.max(0, m.total_plays - used);
      throw new VisitError(
        "exhausted",
        left === 0
          ? "No plays left on this membership"
          : `Only ${left} play${left === 1 ? "" : "s"} left — can't punch ${input.playsUsed}`
      );
    }

    if (m.once_per_day) {
      const todayRes = await client.query(
        `SELECT 1 FROM membership_visits WHERE membership_id = $1 AND visit_date = $2 LIMIT 1`,
        [input.membershipId, input.visitDate]
      );
      if (todayRes.rows.length > 0) {
        throw new VisitError("already_today", "This pass was already used today (once per day)");
      }
    }

    const id = randomUUID();
    const visitRes = await client.query(
      `INSERT INTO membership_visits (
         id, membership_id, phone, kids_count, plays_used, kid_names,
         visit_date, punch_invoice_number, visited_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,'',$8)
       RETURNING *`,
      [
        id, input.membershipId, m.phone, input.kidsCount, input.playsUsed,
        input.kidNames, input.visitDate, Date.now(),
      ]
    );
    await client.query("COMMIT");

    const visit = toVisit(visitRes.rows[0]);
    const membership = toMembership({ ...m, plays_used_total: used + input.playsUsed });
    return { visit, membership };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Stamp the Swipe punch invoice number onto a visit after it's created. */
export async function setVisitInvoice(visitId: string, invoiceNumber: string): Promise<void> {
  await getPool().query(`UPDATE membership_visits SET punch_invoice_number = $2 WHERE id = $1`, [
    visitId,
    invoiceNumber,
  ]);
}

/** Compensation: remove a visit whose Swipe punch invoice failed to create. */
export async function deleteVisit(visitId: string): Promise<void> {
  await getPool().query(`DELETE FROM membership_visits WHERE id = $1`, [visitId]);
}
