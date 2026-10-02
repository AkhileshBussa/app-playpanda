import { randomUUID } from "node:crypto";
import { dbConfigured, getPool } from "../pg";
import { appEnvironment, ensureSchema, ms } from "../db/schema";
import {
  DEFAULT_PRICE_VERSION,
  isPriceVersion,
  packagesReady,
  PRICE_VERSIONS,
  type PriceVersion,
} from "../pricing";
import { plansReady } from "../members/plans";

const KEY = "price_version";
const CACHE_MS = 10_000;

let cached: { version: PriceVersion; at: number } | null = null;

export function isPriceVersionReady(version: PriceVersion): boolean {
  return packagesReady(version) && plansReady(version);
}

export async function getActivePriceVersion(): Promise<PriceVersion> {
  if (!dbConfigured()) return DEFAULT_PRICE_VERSION;
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.version;
  try {
    await ensureSchema();
    const { rows } = await getPool().query(
      `SELECT value FROM app_settings WHERE environment = $1 AND key = $2`,
      [appEnvironment(), KEY]
    );
    const stored = rows[0]?.value;
    const version =
      isPriceVersion(stored) && isPriceVersionReady(stored) ? stored : DEFAULT_PRICE_VERSION;
    cached = { version, at: Date.now() };
    return version;
  } catch (err) {
    console.error("price version read failed:", err);
    return cached?.version ?? DEFAULT_PRICE_VERSION;
  }
}

export class PriceVersionError extends Error {}

export async function setActivePriceVersion(
  version: PriceVersion,
  changedBy: string
): Promise<void> {
  if (!isPriceVersionReady(version)) {
    throw new PriceVersionError(`${version} still has products without a Swipe id`);
  }
  await ensureSchema();
  const env = appEnvironment();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT value FROM app_settings WHERE environment = $1 AND key = $2 FOR UPDATE`,
      [env, KEY]
    );
    const before: PriceVersion = isPriceVersion(rows[0]?.value) ? rows[0].value : DEFAULT_PRICE_VERSION;
    if (before === version) {
      await client.query("ROLLBACK");
      return;
    }
    await client.query(
      `INSERT INTO app_settings (id, environment, key, value, updated_by)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (environment, key)
       DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, last_updated_at = now()`,
      [randomUUID(), env, KEY, JSON.stringify(version), changedBy]
    );
    await client.query(
      `INSERT INTO app_settings_audit (id, environment, key, before, after, changed_by)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)`,
      [randomUUID(), env, KEY, JSON.stringify(before), JSON.stringify(version), changedBy]
    );
    await client.query("COMMIT");
    cached = { version, at: Date.now() };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export interface PriceVersionChange {
  id: string;
  at: number;
  from: PriceVersion | null;
  to: PriceVersion;
  by: string;
}

export async function listPriceVersionChanges(limit = 20): Promise<PriceVersionChange[]> {
  if (!dbConfigured()) return [];
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT id, before, after, changed_by, created_at FROM app_settings_audit
     WHERE environment = $1 AND key = $2
     ORDER BY created_at DESC LIMIT $3`,
    [appEnvironment(), KEY, limit]
  );
  return rows
    .filter((r) => isPriceVersion(r.after))
    .map((r) => ({
      id: r.id,
      at: ms(r.created_at),
      from: isPriceVersion(r.before) ? r.before : null,
      to: r.after,
      by: r.changed_by,
    }));
}

export function priceVersionReadiness(): Record<PriceVersion, boolean> {
  return Object.fromEntries(PRICE_VERSIONS.map((v) => [v, isPriceVersionReady(v)])) as Record<
    PriceVersion,
    boolean
  >;
}
