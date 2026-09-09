/**
 * Google Sheets MIRROR for memberships & visits — visibility only, never the
 * source of truth (that's Postgres, ./db.ts). Every append is best-effort:
 * failures are logged and swallowed so a Sheets outage can't block the counter.
 *
 * Zero-dep integration: a service-account JWT signed with node:crypto,
 * exchanged for an access token, then plain REST appends. Setup (one-time):
 * see docs/memberships.md. Env:
 *   GOOGLE_SHEETS_ID            — the spreadsheet id from its URL
 *   GOOGLE_SHEETS_CLIENT_EMAIL  — service account email (sheet shared with it as Editor)
 *   GOOGLE_SHEETS_PRIVATE_KEY   — service account private key PEM ("\n" escapes ok)
 */

import { createSign } from "node:crypto";
import type { Membership, MembershipVisit } from "./types";
import { playsLeft } from "./types";

const MEMBERSHIPS_TAB = "Memberships";
const VISITS_TAB = "Visits";
const DELETIONS_TAB = "Deletions";
const EDITS_TAB = "Edits";

export const MEMBERSHIP_HEADERS = [
  "Created at (IST)", "Phone", "Customer", "Kids", "Plan", "Total plays",
  "Hours/play", "Kids/play", "Starts", "Expires", "Price (₹)", "Sale invoice",
  "Notes", "Membership ID",
];

export const VISIT_HEADERS = [
  "Visited at (IST)", "Phone", "Customer", "Plan", "Kids in", "Plays used",
  "Plays left after", "Punch invoice", "Kid names", "Membership ID", "Visit ID",
];

// The tabs above are append-only, so deletions land here rather than editing
// history in place.
export const DELETION_HEADERS = [
  "Deleted at (IST)", "What", "Phone", "Customer", "Plan", "Detail", "Reason", "ID",
];

// Same reason as deletions: an edit is logged as what changed, rather than
// rewriting the membership's original row.
export const EDIT_HEADERS = [
  "Edited at (IST)", "Phone", "Customer", "Plan", "Changed", "Membership ID",
];

function config(): { sheetId: string; email: string; key: string } | null {
  const sheetId = process.env.GOOGLE_SHEETS_ID;
  const email = process.env.GOOGLE_SHEETS_CLIENT_EMAIL;
  const key = process.env.GOOGLE_SHEETS_PRIVATE_KEY?.replace(/\\n/g, "\n");
  return sheetId && email && key ? { sheetId, email, key } : null;
}

export function sheetsMirrorConfigured(): boolean {
  return config() !== null;
}

// ── Service-account auth ─────────────────────────────────────────────────────

let cachedToken: { value: string; expiresAt: number } | null = null;

const b64url = (input: string | Buffer) =>
  Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) return cachedToken.value;
  const cfg = config();
  if (!cfg) throw new Error("Sheets mirror not configured");

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: cfg.email,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const jwt = `${header}.${claims}.${b64url(signer.sign(cfg.key))}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !body.access_token) {
    throw new Error(`Google token exchange failed: ${body.error_description ?? body.error ?? res.status}`);
  }
  cachedToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return cachedToken.value;
}

// ── Appends ──────────────────────────────────────────────────────────────────

async function appendRow(tab: string, row: (string | number)[]): Promise<void> {
  const cfg = config();
  if (!cfg) return; // mirror not set up — silently skip
  const token = await getAccessToken();
  const range = encodeURIComponent(`${tab}!A1`);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${cfg.sheetId}/values/${range}:append` +
      `?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [row] }),
      cache: "no-store",
    }
  );
  if (!res.ok) {
    throw new Error(`Sheets append to ${tab} failed (${res.status}): ${await res.text()}`);
  }
}

/**
 * One-time setup (scripts/setup-sheets.ts): create the Memberships/Visits tabs
 * if missing and (re)write their header rows. Idempotent.
 */
export async function setupSheetTabs(): Promise<string[]> {
  const cfg = config();
  if (!cfg) throw new Error("Set GOOGLE_SHEETS_ID, GOOGLE_SHEETS_CLIENT_EMAIL, GOOGLE_SHEETS_PRIVATE_KEY first");
  const token = await getAccessToken();
  const log: string[] = [];
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${cfg.sheetId}`;
  const authHeaders = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const metaRes = await fetch(`${base}?fields=sheets.properties.title`, { headers: authHeaders });
  if (!metaRes.ok) {
    throw new Error(`Couldn't open the spreadsheet (${metaRes.status}) — is it shared with ${cfg.email}?`);
  }
  const meta = (await metaRes.json()) as { sheets?: Array<{ properties: { title: string } }> };
  const existing = new Set((meta.sheets ?? []).map((s) => s.properties.title));

  const missing = [MEMBERSHIPS_TAB, VISITS_TAB, DELETIONS_TAB, EDITS_TAB].filter(
    (t) => !existing.has(t)
  );
  if (missing.length) {
    const res = await fetch(`${base}:batchUpdate`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ requests: missing.map((title) => ({ addSheet: { properties: { title } } })) }),
    });
    if (!res.ok) throw new Error(`Couldn't create tabs (${res.status}): ${await res.text()}`);
    log.push(`Created tab(s): ${missing.join(", ")}`);
  }

  for (const [tab, headers] of [
    [MEMBERSHIPS_TAB, MEMBERSHIP_HEADERS],
    [VISITS_TAB, VISIT_HEADERS],
    [DELETIONS_TAB, DELETION_HEADERS],
    [EDITS_TAB, EDIT_HEADERS],
  ] as const) {
    const range = encodeURIComponent(`${tab}!A1`);
    const res = await fetch(`${base}/values/${range}?valueInputOption=RAW`, {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({ values: [headers as unknown as string[]] }),
    });
    if (!res.ok) throw new Error(`Couldn't write headers to ${tab} (${res.status}): ${await res.text()}`);
    log.push(`Headers ready on "${tab}"`);
  }
  return log;
}

const istDateTime = (ms: number) =>
  new Date(ms).toLocaleString("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: true,
    timeZone: "Asia/Kolkata",
  });

/** Append the membership to the sheet. Best-effort — never throws. */
export async function mirrorMembership(m: Membership): Promise<void> {
  try {
    await appendRow(MEMBERSHIPS_TAB, [
      istDateTime(m.createdAt),
      m.phone,
      m.customerName,
      m.kidNames,
      m.planName,
      m.totalPlays ?? "Unlimited",
      m.hoursPerPlay,
      m.kidsPerPlay,
      m.startsOn,
      m.expiresOn,
      m.priceInr ?? "",
      m.saleInvoiceNumber,
      m.notes,
      m.id,
    ]);
  } catch (err) {
    console.error("sheets mirror (membership) failed:", err);
  }
}

/** Log a soft delete (membership or punch) to the sheet. Never throws. */
export async function mirrorDeletion(input: {
  what: "Membership" | "Punch";
  membership: Membership;
  /** Extra context, e.g. the punch's time and invoice number. */
  detail: string;
  reason: string;
  id: string;
  at: number;
}): Promise<void> {
  try {
    await appendRow(DELETIONS_TAB, [
      istDateTime(input.at),
      input.what,
      input.membership.phone,
      input.membership.customerName,
      input.membership.planName,
      input.detail,
      input.reason,
      input.id,
    ]);
  } catch (err) {
    console.error("sheets mirror (deletion) failed:", err);
  }
}

/** Log what an edit changed, field by field. Best-effort — never throws. */
export async function mirrorEdit(input: {
  before: Membership;
  after: Membership;
}): Promise<void> {
  const { before, after } = input;
  const changed: string[] = [];
  const note = (label: string, from: unknown, to: unknown) => {
    if (String(from) !== String(to)) changed.push(`${label}: ${from} → ${to}`);
  };
  note("Customer", before.customerName, after.customerName);
  note("Kids", before.kidNames || "—", after.kidNames || "—");
  note("Plan", before.planName, after.planName);
  note("Total plays", before.totalPlays ?? "Unlimited", after.totalPlays ?? "Unlimited");
  note("Hours/play", before.hoursPerPlay, after.hoursPerPlay);
  note("Kids/play", before.kidsPerPlay, after.kidsPerPlay);
  note("Mon–Fri only", before.weekdaysOnly, after.weekdaysOnly);
  note("Starts", before.startsOn, after.startsOn);
  note("Expires", before.expiresOn, after.expiresOn);
  note("Recorded on", istDateTime(before.createdAt), istDateTime(after.createdAt));
  note("Paid by", before.paidBy || "—", after.paidBy || "—");
  note("Notes", before.notes || "—", after.notes || "—");
  if (!changed.length) return;

  try {
    await appendRow(EDITS_TAB, [
      istDateTime(Date.now()),
      after.phone,
      after.customerName,
      after.planName,
      changed.join(" · "),
      after.id,
    ]);
  } catch (err) {
    console.error("sheets mirror (edit) failed:", err);
  }
}

/** Append the visit to the sheet. Best-effort — never throws. */
export async function mirrorVisit(v: MembershipVisit, m: Membership): Promise<void> {
  try {
    const left = playsLeft(m);
    await appendRow(VISITS_TAB, [
      istDateTime(v.visitedAt),
      m.phone,
      m.customerName,
      m.planName,
      v.kidsCount,
      v.playsUsed,
      left ?? "Unlimited",
      v.punchInvoiceNumber,
      v.kidNames,
      m.id,
      v.id,
    ]);
  } catch (err) {
    console.error("sheets mirror (visit) failed:", err);
  }
}
