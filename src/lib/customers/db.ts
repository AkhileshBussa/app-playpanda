/**
 * Customer store — one row per family, keyed by phone.
 *
 * Every flow that touches a customer (booking, membership, discount, punch)
 * resolves the phone through here first and carries the customer ID from then
 * on. The Swipe party id is tucked away in swipe_ref; nothing outside the
 * billing adapter and this column knows Swipe has customers at all.
 */

import { randomUUID } from "node:crypto";
import { getPool } from "../pg";
import { ensureSchema, ms, msOrNull } from "../db/schema";

export interface Customer {
  id: string;
  phone: string;
  name: string;
  /** Comma-separated kid names, informational. */
  kidNames: string;
  /** Comma-separated "how did you hear about us?" answers; '' = never asked. */
  heardFromSources: string;
  heardFromAt: number | null;
  swipeRef: string | null;
  createdAt: number;
  lastUpdatedAt: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function toCustomer(r: any): Customer {
  return {
    id: r.id,
    phone: r.phone,
    name: r.name,
    kidNames: r.kid_names,
    heardFromSources: r.heard_from_sources,
    heardFromAt: msOrNull(r.heard_from_at),
    swipeRef: r.swipe_ref ?? null,
    createdAt: ms(r.created_at),
    lastUpdatedAt: ms(r.last_updated_at),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface UpsertCustomerInput {
  phone: string;
  name: string;
  /** Only written when non-empty — a booking without kid names must not blank them. */
  kidNames?: string;
  /** Only written when the row doesn't have one yet (a party id never changes). */
  swipeRef?: string | null;
}

/**
 * Insert-or-refresh by phone; `isNew` says whether this call created the row
 * (the "first-time family" signal the heard-from question keys off).
 */
export async function upsertCustomer(
  input: UpsertCustomerInput
): Promise<{ customer: Customer; isNew: boolean }> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `INSERT INTO customers (id, phone, name, kid_names, swipe_ref)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (phone) DO UPDATE SET
       name = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE customers.name END,
       kid_names = CASE WHEN EXCLUDED.kid_names <> '' THEN EXCLUDED.kid_names
                        ELSE customers.kid_names END,
       swipe_ref = COALESCE(customers.swipe_ref, EXCLUDED.swipe_ref),
       last_updated_at = now()
     RETURNING *, (xmax = 0) AS inserted`,
    [randomUUID(), input.phone, input.name.trim(), input.kidNames?.trim() ?? "", input.swipeRef ?? null]
  );
  return { customer: toCustomer(rows[0]), isNew: Boolean(rows[0].inserted) };
}

export async function getCustomerByPhone(phone: string): Promise<Customer | null> {
  await ensureSchema();
  const { rows } = await getPool().query(`SELECT * FROM customers WHERE phone = $1`, [phone]);
  return rows[0] ? toCustomer(rows[0]) : null;
}

export async function getCustomer(id: string): Promise<Customer | null> {
  await ensureSchema();
  const { rows } = await getPool().query(`SELECT * FROM customers WHERE id = $1`, [id]);
  return rows[0] ? toCustomer(rows[0]) : null;
}

/**
 * Record the "how did you hear about us?" answer — first answer wins, so a
 * replayed request or a second booking can't overwrite what they said the
 * first time.
 */
export async function setHeardFrom(customerId: string, sources: string[]): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `UPDATE customers
     SET heard_from_sources = $2, heard_from_at = now(), last_updated_at = now()
     WHERE id = $1 AND heard_from_sources = ''`,
    [customerId, sources.join(", ")]
  );
}
