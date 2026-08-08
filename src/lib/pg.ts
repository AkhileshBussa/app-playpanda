/**
 * The app's single Postgres pool (Neon via Vercel Marketplace; any
 * DATABASE_URL works). Memberships and the staff tools both go through here so
 * one serverless instance holds one small pool rather than one per feature.
 */

import { Pool } from "pg";

let pool: Pool | null = null;

export function getPool(): Pool {
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

export function dbConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

/**
 * Run an idempotent `CREATE TABLE IF NOT EXISTS …` block once per process, so
 * installing the database is the only migration step. A failure clears the
 * memo so the next request retries instead of wedging the feature.
 */
export function onceSchema(ddl: string): () => Promise<void> {
  let ready: Promise<void> | null = null;
  return () => {
    if (!ready) {
      ready = getPool()
        .query(ddl)
        .then(() => undefined)
        .catch((err) => {
          ready = null;
          throw err;
        });
    }
    return ready;
  };
}
