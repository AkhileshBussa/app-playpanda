/**
 * Cash ledger store — the DECLARED side of the books.
 *
 * Only four things live here: what the counter counted each day, the cash that
 * moved for reasons that aren't sales, each month's opening balance, and the
 * append-only history of every change to those three. Everything else the
 * ledger shows (the Swipe tally, cash spent from the drawer) is read live from
 * Swipe by ./month.ts, so there is no second copy of the books to drift — same
 * rule the expenses page already follows.
 *
 * Every write goes through a transaction that records its own history in the
 * same commit. That's the point of the design: there is no code path that can
 * change a figure without leaving a trace, because changing it and recording
 * the change either both happen or neither does.
 *
 * Tables are defined in ../db/schema.ts with the rest of the database.
 */

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { getPool } from "../pg";
import { appEnvironment, ensureSchema, ms } from "../db/schema";
import { describeEdit } from "./history";
import type {
  Actor,
  CashMovement,
  DayDeclaration,
  EditAction,
  EditEntity,
  LedgerEdit,
  MovementDirection,
} from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface MonthRow {
  month: string;
  openingInr: number;
  startsOn: string | null;
  isExplicit: boolean;
  setBy: string;
}

function toMonth(r: any): MonthRow {
  return {
    month: r.month,
    openingInr: Number(r.opening_inr),
    startsOn: r.starts_on ?? null,
    isExplicit: r.is_explicit,
    setBy: r.set_by ?? "",
  };
}

function toDeclaration(r: any): DayDeclaration {
  return {
    day: r.day,
    cashInr: Number(r.declared_cash_inr),
    onlineInr: Number(r.declared_online_inr),
    note: r.note ?? "",
    enteredBy: r.entered_by ?? "",
    updatedAt: ms(r.last_updated_at),
  };
}

function toMovement(r: any): CashMovement {
  return {
    id: r.id,
    day: r.day,
    direction: r.direction as MovementDirection,
    amountInr: Number(r.amount_inr),
    reason: r.reason ?? "",
    party: r.party ?? "",
    recordedBy: r.recorded_by ?? "",
    createdAt: ms(r.created_at),
  };
}

// ── History ──────────────────────────────────────────────────────────────────

/**
 * The snapshots written into the audit row.
 *
 * Trimmed on purpose: only the fields a person could have changed. Ids and
 * timestamps are already columns on the audit row, and copying them into the
 * blob would just make the history harder to read in psql.
 */
const snapshot = {
  declaration: (d: DayDeclaration | null) =>
    d && { cashInr: d.cashInr, onlineInr: d.onlineInr, note: d.note, enteredBy: d.enteredBy },
  movement: (m: CashMovement | null) =>
    m && {
      direction: m.direction,
      amountInr: m.amountInr,
      reason: m.reason,
      party: m.party,
      recordedBy: m.recordedBy,
    },
  opening: (o: { openingInr: number; startsOn: string | null } | null) =>
    o && { openingInr: o.openingInr, startsOn: o.startsOn },
};

/** Append one history row. Only ever called inside the write's own transaction. */
async function recordEdit(
  client: PoolClient,
  input: {
    day: string;
    entity: EditEntity;
    action: EditAction;
    before: object | null;
    after: object | null;
    actor: Actor;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO cash_audit (id, environment, day, entity, action, before, after, changed_by, changed_tier)
     VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8,$9)`,
    [
      randomUUID(),
      appEnvironment(),
      input.day,
      input.entity,
      input.action,
      input.before ? JSON.stringify(input.before) : null,
      input.after ? JSON.stringify(input.after) : null,
      input.actor.name,
      input.actor.tier,
    ]
  );
}

function toEdit(r: any): LedgerEdit {
  const entity = r.entity as EditEntity;
  const action = r.action as EditAction;
  return {
    id: r.id,
    at: ms(r.created_at),
    entity,
    action,
    by: r.changed_by ?? "",
    tier: r.changed_tier === "owner" ? "owner" : "counter",
    summary: describeEdit(entity, action, r.before, r.after),
  };
}

/** Every change touching days in [from, to]. Newest first. */
export async function listEdits(from: string, to: string): Promise<LedgerEdit[]> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT *, day::text AS day FROM cash_audit
     WHERE environment = $1 AND day BETWEEN $2::date AND $3::date
     ORDER BY created_at DESC`,
    [appEnvironment(), from, to]
  );
  return rows.map(toEdit);
}

/** The day an edit belongs to, kept alongside so the board can group them. */
export async function listEditsByDay(
  from: string,
  to: string
): Promise<Map<string, LedgerEdit[]>> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT *, day::text AS day FROM cash_audit
     WHERE environment = $1 AND day BETWEEN $2::date AND $3::date
     ORDER BY created_at DESC`,
    [appEnvironment(), from, to]
  );
  const byDay = new Map<string, LedgerEdit[]>();
  for (const r of rows) {
    const list = byDay.get(r.day) ?? [];
    list.push(toEdit(r));
    byDay.set(r.day, list);
  }
  return byDay;
}

// ── Months ───────────────────────────────────────────────────────────────────

export async function getMonth(month: string): Promise<MonthRow | null> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT *, starts_on::text AS starts_on FROM cash_months
     WHERE month = $1 AND environment = $2`,
    [month, appEnvironment()]
  );
  return rows[0] ? toMonth(rows[0]) : null;
}

/** The first month this environment's ledger knows about, if any. */
export async function earliestMonth(): Promise<string | null> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT month FROM cash_months WHERE environment = $1 ORDER BY month LIMIT 1`,
    [appEnvironment()]
  );
  return rows[0]?.month ?? null;
}

/**
 * Write a month's opening balance.
 *
 * `isExplicit` is the whole point of the row: an explicit opening is a human
 * saying "this much was in the drawer", and nothing may move it. A
 * non-explicit one is last month's close, cached here and re-derived on every
 * read — so correcting an old day still flows forward into every month after
 * it. An explicit opening is therefore never overwritten by a carry.
 *
 * Passing an `actor` is what marks the write as a human act and records it in
 * the history. The carry-forward path passes none, deliberately: it runs on
 * every read, and logging it would drown the real edits.
 */
export async function setOpening(input: {
  month: string;
  openingInr: number;
  isExplicit: boolean;
  setBy?: string;
  startsOn?: string | null;
  actor?: Actor;
}): Promise<MonthRow> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const prev = await client.query(
      `SELECT *, starts_on::text AS starts_on FROM cash_months
       WHERE month = $1 AND environment = $2 FOR UPDATE`,
      [input.month, appEnvironment()]
    );
    const before = prev.rows[0] ? toMonth(prev.rows[0]) : null;

    const { rows } = await client.query(
      `INSERT INTO cash_months (month, environment, opening_inr, starts_on, is_explicit, set_by)
       VALUES ($1,$2,$3,$4::date,$5,$6)
       ON CONFLICT (month, environment) DO UPDATE SET
         opening_inr = CASE
           WHEN cash_months.is_explicit AND NOT EXCLUDED.is_explicit
             THEN cash_months.opening_inr
           ELSE EXCLUDED.opening_inr END,
         starts_on = COALESCE(EXCLUDED.starts_on, cash_months.starts_on),
         is_explicit = cash_months.is_explicit OR EXCLUDED.is_explicit,
         set_by = CASE WHEN EXCLUDED.is_explicit THEN EXCLUDED.set_by ELSE cash_months.set_by END,
         last_updated_at = now()
       RETURNING *, starts_on::text AS starts_on`,
      [
        input.month,
        appEnvironment(),
        input.openingInr,
        input.startsOn ?? null,
        input.isExplicit,
        input.setBy ?? "",
      ]
    );
    const after = toMonth(rows[0]);

    const moved =
      !before ||
      before.openingInr !== after.openingInr ||
      (before.startsOn ?? null) !== (after.startsOn ?? null);
    if (input.actor && moved) {
      await recordEdit(client, {
        // Opening balances hang off the first day the month covers.
        day: after.startsOn ?? `${input.month}-01`,
        entity: "opening",
        action: before?.isExplicit ? "updated" : "created",
        before: before?.isExplicit ? snapshot.opening(before) : null,
        after: snapshot.opening(after),
        actor: input.actor,
      });
    }

    await client.query("COMMIT");
    return after;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── Daily declarations ───────────────────────────────────────────────────────

export async function listDeclarations(from: string, to: string): Promise<DayDeclaration[]> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT *, day::text AS day FROM cash_days
     WHERE environment = $1 AND day BETWEEN $2::date AND $3::date
     -- Qualified: the day::text alias above would otherwise shadow the column.
     ORDER BY cash_days.day`,
    [appEnvironment(), from, to]
  );
  return rows.map(toDeclaration);
}

/** Declaring a day again corrects it — one row per day, always, plus history. */
export async function declareDay(input: {
  day: string;
  cashInr: number;
  onlineInr: number;
  note?: string;
  enteredBy?: string;
  actor: Actor;
}): Promise<DayDeclaration> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const prev = await client.query(
      `SELECT *, day::text AS day FROM cash_days
       WHERE day = $1::date AND environment = $2 FOR UPDATE`,
      [input.day, appEnvironment()]
    );
    const before = prev.rows[0] ? toDeclaration(prev.rows[0]) : null;

    const { rows } = await client.query(
      `INSERT INTO cash_days (id, day, environment, declared_cash_inr, declared_online_inr, note, entered_by)
       VALUES ($1,$2::date,$3,$4,$5,$6,$7)
       ON CONFLICT (day, environment) DO UPDATE SET
         declared_cash_inr = EXCLUDED.declared_cash_inr,
         declared_online_inr = EXCLUDED.declared_online_inr,
         note = EXCLUDED.note,
         entered_by = EXCLUDED.entered_by,
         last_updated_at = now()
       RETURNING *, day::text AS day`,
      [
        randomUUID(),
        input.day,
        appEnvironment(),
        input.cashInr,
        input.onlineInr,
        input.note ?? "",
        input.enteredBy ?? "",
      ]
    );
    const after = toDeclaration(rows[0]);

    // Opening the sheet and saving it unchanged is not an edit, and logging it
    // would bury the corrections that matter under accidental re-saves.
    const changed =
      !before ||
      before.cashInr !== after.cashInr ||
      before.onlineInr !== after.onlineInr ||
      before.note !== after.note ||
      before.enteredBy !== after.enteredBy;
    if (changed) {
      await recordEdit(client, {
        day: input.day,
        entity: "declaration",
        action: before ? "updated" : "created",
        before: snapshot.declaration(before),
        after: snapshot.declaration(after),
        actor: input.actor,
      });
    }

    await client.query("COMMIT");
    return after;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── Movements ────────────────────────────────────────────────────────────────

export async function listMovements(from: string, to: string): Promise<CashMovement[]> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT *, day::text AS day FROM cash_movements
     WHERE environment = $1 AND day BETWEEN $2::date AND $3::date
     ORDER BY cash_movements.day, created_at`,
    [appEnvironment(), from, to]
  );
  return rows.map(toMovement);
}

export async function addMovement(input: {
  day: string;
  direction: MovementDirection;
  amountInr: number;
  reason?: string;
  party?: string;
  recordedBy?: string;
  actor: Actor;
}): Promise<CashMovement> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO cash_movements (id, day, environment, direction, amount_inr, reason, party, recorded_by)
       VALUES ($1,$2::date,$3,$4,$5,$6,$7,$8)
       RETURNING *, day::text AS day`,
      [
        randomUUID(),
        input.day,
        appEnvironment(),
        input.direction,
        input.amountInr,
        input.reason ?? "",
        input.party ?? "",
        input.recordedBy ?? "",
      ]
    );
    const movement = toMovement(rows[0]);
    await recordEdit(client, {
      day: input.day,
      entity: "movement",
      action: "created",
      before: null,
      after: snapshot.movement(movement),
      actor: input.actor,
    });
    await client.query("COMMIT");
    return movement;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Remove a movement. The row goes; the history of it does not — a withdrawal
 * that was logged and then removed is exactly the kind of thing the owner
 * should be able to see happened.
 */
export async function deleteMovement(id: string, actor: Actor): Promise<boolean> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `DELETE FROM cash_movements WHERE id = $1 AND environment = $2
       RETURNING *, day::text AS day`,
      [id, appEnvironment()]
    );
    if (!rows[0]) {
      await client.query("COMMIT");
      return false;
    }
    const removed = toMovement(rows[0]);
    await recordEdit(client, {
      day: removed.day,
      entity: "movement",
      action: "deleted",
      before: snapshot.movement(removed),
      after: null,
      actor,
    });
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/* eslint-enable @typescript-eslint/no-explicit-any */
