/**
 * Membership store — the durable source of truth for memberships and visits;
 * the Google Sheet (./sheets.ts) is a best-effort mirror for easy viewing.
 *
 * Rows reference customers/products/invoices by OUR ids (see ../db/schema.ts);
 * the wire types keep exposing phone, names and invoice numbers via joins so
 * the counter UI reads the same shapes it always has.
 */

import { randomUUID } from "node:crypto";
import { type PoolClient } from "pg";
import { dbConfigured, getPool } from "../pg";
import { ensureSchema, ms, msOrNull } from "../db/schema";
import { upsertCustomer } from "../customers/db";
import { ensureProduct } from "../products/db";
import { ensureExternalInvoice, findInvoiceIdByNumber } from "../invoices/db";
import type { Membership, MembershipVisit } from "./types";

export function membersDbConfigured(): boolean {
  return dbConfigured();
}

// ── Row mapping ──────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
function toMembership(r: any): Membership {
  return {
    id: r.id,
    customerId: r.customer_id,
    phone: r.phone,
    customerName: r.customer_name,
    kidNames: r.kid_names,
    planKey: r.plan_key,
    planName: r.plan_name,
    punchProductId: Number(r.punch_swipe_ref),
    punchProductName: r.punch_product_name,
    totalPlays: r.total_plays,
    hoursPerPlay: r.hours_per_play,
    kidsPerPlay: r.kids_per_play,
    priceInr: r.price_inr == null ? null : Number(r.price_inr),
    saleInvoiceNumber: r.sale_invoice_number ?? "",
    weekdaysOnly: r.weekdays_only,
    oncePerDay: r.once_per_day,
    startsOn: r.starts_on,
    expiresOn: r.expires_on,
    notes: r.notes,
    createdAt: ms(r.created_at),
    playsUsed: Number(r.plays_used_total ?? 0),
    deletedAt: msOrNull(r.deleted_at),
    deletedReason: r.deleted_reason ?? "",
  };
}

function toVisit(r: any): MembershipVisit {
  return {
    id: r.id,
    membershipId: r.membership_id,
    kidsCount: r.kids_count,
    playsUsed: r.plays_used,
    kidNames: r.kid_names,
    visitDate: r.visit_date_ist,
    punchInvoiceNumber: r.punch_invoice_number ?? "",
    visitedAt: ms(r.visited_at),
    deletedAt: msOrNull(r.deleted_at),
    deletedReason: r.deleted_reason ?? "",
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// Deleted punches give their plays back, so they're excluded from the total.
const MEMBERSHIP_SELECT = `
  SELECT m.*, m.starts_on::text AS starts_on, m.expires_on::text AS expires_on,
    c.phone, c.name AS customer_name,
    p.swipe_ref AS punch_swipe_ref, p.name AS punch_product_name,
    si.number AS sale_invoice_number,
    COALESCE(v.used, 0) AS plays_used_total
  FROM memberships m
  JOIN customers c ON c.id = m.customer_id
  JOIN products p ON p.id = m.product_id
  LEFT JOIN invoices si ON si.id = m.sale_invoice_id
  LEFT JOIN (
    SELECT membership_id, SUM(plays_used) AS used
    FROM membership_visits WHERE deleted_at IS NULL GROUP BY membership_id
  ) v ON v.membership_id = m.id
`;

// The IST day a visit consumed plays against, plus the punch invoice number
// (metadata keeps the number even when the mirror write itself failed).
const VISIT_SELECT = `
  SELECT v.*,
    (v.visited_at AT TIME ZONE 'Asia/Kolkata')::date::text AS visit_date_ist,
    COALESCE(pi.number, v.metadata->>'punch_invoice_number', '') AS punch_invoice_number
  FROM membership_visits v
  LEFT JOIN invoices pi ON pi.id = v.punch_invoice_id
`;

// ── Memberships ──────────────────────────────────────────────────────────────

export interface CreateMembershipInput {
  phone: string;
  customerName: string;
  kidNames: string;
  planKey: string;
  planName: string;
  /** Swipe punch product id (plans.ts) — resolved to our products row here. */
  punchProductId: number;
  punchProductName: string;
  punchTaxRatePercent?: number;
  totalPlays: number | null;
  hoursPerPlay: number;
  kidsPerPlay: number;
  priceInr: number | null;
  saleInvoiceNumber: string;
  /** Details of the (hand-billed) sale invoice, when the caller looked them up. */
  sale?: { totalInr: number | null; issuedAt: number | null } | null;
  weekdaysOnly: boolean;
  oncePerDay: boolean;
  startsOn: string;
  expiresOn: string;
  notes: string;
}

export async function createMembership(input: CreateMembershipInput): Promise<Membership> {
  await ensureSchema();

  const { customer } = await upsertCustomer({
    phone: input.phone,
    name: input.customerName,
    kidNames: input.kidNames,
  });
  const productId = await ensureProduct({
    swipeRef: String(input.punchProductId),
    name: input.punchProductName,
    kind: "membership_punch",
    itemType: "Service",
    priceInr: null,
    taxRatePercent: input.punchTaxRatePercent ?? 18,
  });

  // The sale is billed by hand in Swipe; give it a mirror row so the
  // membership can reference it by id like everything else.
  let saleInvoiceId: string | null = null;
  if (input.saleInvoiceNumber) {
    saleInvoiceId = await findInvoiceIdByNumber(input.saleInvoiceNumber);
    if (!saleInvoiceId) {
      saleInvoiceId = await ensureExternalInvoice({
        number: input.saleInvoiceNumber,
        customer: { phone: input.phone, name: input.customerName },
        totalInr: input.sale?.totalInr ?? null,
        issuedAt: input.sale?.issuedAt ?? null,
        metadata: { note: "membership sale (billed at the counter)" },
      });
    }
  }

  const { rows } = await getPool().query(
    `INSERT INTO memberships (
       id, customer_id, product_id, sale_invoice_id, plan_key, plan_name,
       kid_names, total_plays, hours_per_play, kids_per_play, price_inr,
       weekdays_only, once_per_day, starts_on, expires_on, notes
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::date,$15::date,$16)
     RETURNING id`,
    [
      randomUUID(), customer.id, productId, saleInvoiceId, input.planKey,
      input.planName, input.kidNames, input.totalPlays, input.hoursPerPlay,
      input.kidsPerPlay, input.priceInr, input.weekdaysOnly, input.oncePerDay,
      input.startsOn, input.expiresOn, input.notes,
    ]
  );
  const created = await getMembership(rows[0].id);
  if (!created) throw new Error("membership vanished after insert");
  return created;
}

export async function getMembership(id: string): Promise<Membership | null> {
  await ensureSchema();
  const { rows } = await getPool().query(`${MEMBERSHIP_SELECT} WHERE m.id = $1`, [id]);
  return rows[0] ? toMembership(rows[0]) : null;
}

export async function listMembershipsByPhone(phone: string): Promise<Membership[]> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `${MEMBERSHIP_SELECT} WHERE c.phone = $1 ORDER BY m.created_at DESC`,
    [phone]
  );
  return rows.map(toMembership);
}

/** Sale invoice numbers already linked to a membership, for the pick-list. */
export async function listLinkedSaleInvoices(): Promise<string[]> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT DISTINCT si.number FROM memberships m
     JOIN invoices si ON si.id = m.sale_invoice_id
     WHERE m.deleted_at IS NULL`
  );
  return rows.map((r) => r.number as string);
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
    `${VISIT_SELECT} WHERE v.membership_id = $1 ORDER BY v.visited_at DESC`,
    [membershipId]
  );
  return rows.map(toVisit);
}

export async function listAllVisits(): Promise<MembershipVisit[]> {
  await ensureSchema();
  const { rows } = await getPool().query(`${VISIT_SELECT} ORDER BY v.visited_at DESC`);
  return rows.map(toVisit);
}

/** Visit rejected for a business-rule reason the UI should explain. */
export class VisitError extends Error {
  constructor(
    readonly code: "not_found" | "expired" | "exhausted" | "already_today" | "deleted",
    message: string
  ) {
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
  let visitId: string;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT *, expires_on::text AS expires_on FROM memberships WHERE id = $1 FOR UPDATE`,
      [input.membershipId]
    );
    if (!rows[0]) throw new VisitError("not_found", "Membership not found");
    const m = rows[0];

    if (m.deleted_at != null) {
      throw new VisitError("deleted", "This membership was deleted and can't be punched");
    }

    if (input.visitDate > m.expires_on) {
      throw new VisitError("expired", `This membership expired on ${m.expires_on}`);
    }

    const usedRes = await client.query(
      `SELECT COALESCE(SUM(plays_used), 0) AS used FROM membership_visits
       WHERE membership_id = $1 AND deleted_at IS NULL`,
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
        `SELECT 1 FROM membership_visits
         WHERE membership_id = $1
           AND (visited_at AT TIME ZONE 'Asia/Kolkata')::date = $2::date
           AND deleted_at IS NULL LIMIT 1`,
        [input.membershipId, input.visitDate]
      );
      if (todayRes.rows.length > 0) {
        throw new VisitError("already_today", "This pass was already used today (once per day)");
      }
    }

    visitId = randomUUID();
    await client.query(
      `INSERT INTO membership_visits (
         id, membership_id, kids_count, plays_used, kid_names
       ) VALUES ($1,$2,$3,$4,$5)`,
      [visitId, input.membershipId, input.kidsCount, input.playsUsed, input.kidNames]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // Plain reads after the commit, for the joined wire shapes.
  const [visitRows, membership] = await Promise.all([
    getPool().query(`${VISIT_SELECT} WHERE v.id = $1`, [visitId]),
    getMembership(input.membershipId),
  ]);
  if (!membership || !visitRows.rows[0]) throw new Error("visit vanished after insert");
  return { visit: toVisit(visitRows.rows[0]), membership };
}

/** Link the visit to its punch invoice once the mirror row exists. The number
 *  also goes into metadata so the ledger reads right even if the invoice
 *  mirror is missing (its write is best-effort). */
export async function setVisitInvoice(
  visitId: string,
  link: { invoiceId: string | null; invoiceNumber: string }
): Promise<void> {
  await getPool().query(
    `UPDATE membership_visits SET
       punch_invoice_id = COALESCE($2, punch_invoice_id),
       metadata = metadata || $3::jsonb,
       last_updated_at = now()
     WHERE id = $1`,
    [visitId, link.invoiceId, JSON.stringify({ punch_invoice_number: link.invoiceNumber })]
  );
}

/**
 * Compensation for a punch whose Swipe invoice failed: the visit never really
 * happened, so this is the one case that genuinely removes the row.
 */
export async function hardDeleteVisit(visitId: string): Promise<void> {
  await getPool().query(`DELETE FROM membership_visits WHERE id = $1`, [visitId]);
}

// ── Soft deletes ─────────────────────────────────────────────────────────────
// Rows are kept and marked, so the ledger still shows what happened and why.
// Deleting the last punch of a membership hands its plays back automatically
// (every plays-used sum filters on deleted_at IS NULL).

/** Already-deleted rows are returned unchanged rather than re-stamped. */
export async function softDeleteMembership(
  id: string,
  reason: string
): Promise<Membership | null> {
  await ensureSchema();
  await getPool().query(
    `UPDATE memberships SET deleted_at = now(), deleted_reason = $2, last_updated_at = now()
     WHERE id = $1 AND deleted_at IS NULL`,
    [id, reason]
  );
  return getMembership(id);
}

export async function softDeleteVisit(
  id: string,
  reason: string
): Promise<{ visit: MembershipVisit; membership: Membership } | null> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `UPDATE membership_visits SET deleted_at = now(), deleted_reason = $2, last_updated_at = now()
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING id`,
    [id, reason]
  );
  if (!rows[0]) return null;
  const { rows: visitRows } = await getPool().query(`${VISIT_SELECT} WHERE v.id = $1`, [id]);
  const visit = toVisit(visitRows[0]);
  const membership = await getMembership(visit.membershipId);
  return membership ? { visit, membership } : null;
}
