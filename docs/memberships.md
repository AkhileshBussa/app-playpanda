# Memberships (`/members`)

Staff-only counter for PlayPanda memberships (same password as `/ops`).

## How it fits the existing workflow

1. Customer picks a plan and pays — **unchanged**.
2. Manager bills the membership sale in Swipe — **unchanged** (products
   "Fun Five Pass", "Panda Pro 12", "Panda Max 25", "Supervised Play Pass").
3. Manager records the membership on **`/members`** (phone number + plan;
   fixed plans are one tap, custom plans set their own plays/hours/validity
   but map to an existing Swipe punch product).
4. When the member visits, the manager looks up the phone number on
   `/members` — it shows plays used, plays allowed, plays left, and expiry.
5. If plays are left, **Punch a visit** deducts them (2 kids on one visit =
   2 plays, unless the plan covers more kids per play) and…
6. …creates a **₹0 invoice in Swipe** with the plan's Punch product — so the
   visit shows up in Swipe history and as a teal MEMBER session on `/ops`,
   exactly like manually-punched visits do today.

Every membership and visit is stored in **Postgres** (source of truth) and
mirrored to a **Google Sheet** (best-effort, for easy viewing).

## Plan catalog

Defined in `src/lib/members/plans.ts`, mirroring the Swipe catalog
(company 2430519):

| Plan | Sale product | Punch product | Plays | Hrs/play | Validity | Price |
|---|---|---|---|---|---|---|
| Fun Five Pass | 6 | 160 | 5 | 2 | 6 mo | ₹2,499 |
| Panda Pro 12 | 7 | 162 | 12 | 2 | 12 mo | ₹4,999 |
| Panda Max 25 | 8 | 161 | 25 | 2 | 12 mo | ₹7,999 |
| Supervised Play Pass | 9 | 163 | Unlimited · 1/day · Mon–Fri | 4 | 1 mo | ₹5,999 |

Plays/hours/validity were read from each product's Swipe custom fields
("Number of Plays", "Number of Hours", "Validity (in Months)"). If the
catalog changes in Swipe, update `plans.ts` to match.

## Setup

### 1. Postgres (required) — Neon via Vercel Marketplace

1. Vercel dashboard → the project → **Storage** → **Create Database** →
   **Neon** (free tier is plenty — this stores a few rows per day).
2. Connect it to the project; Vercel injects `DATABASE_URL` automatically.
3. Locally: `vercel env pull .env.local` (or paste the pooled connection
   string into `.env.local`).

Tables are created automatically on first use (`src/lib/members/db.ts`) —
no migration step.

### 2. Google Sheets mirror (optional but recommended)

1. [Google Cloud console](https://console.cloud.google.com): create a project
   (or reuse one) → **APIs & Services** → enable the **Google Sheets API**.
2. **Credentials → Create credentials → Service account** (no roles needed).
   Open it → **Keys → Add key → JSON** — download the key file.
3. Create the spreadsheet (any name) and **share it with the service
   account's email** (from the JSON, `client_email`) as **Editor**.
4. Fill `.env.local` (and the same vars on Vercel):
   - `GOOGLE_SHEETS_ID` — from the sheet URL: `docs.google.com/spreadsheets/d/<THIS>/edit`
   - `GOOGLE_SHEETS_CLIENT_EMAIL` — `client_email` from the JSON
   - `GOOGLE_SHEETS_PRIVATE_KEY` — `private_key` from the JSON (keep the
     `\n` escapes; wrap in quotes)
5. Create the tabs + headers: `npx tsx scripts/setup-sheets.ts`

The mirror is fire-and-forget: if Sheets is down or unconfigured, the counter
keeps working and rows simply don't mirror (they're always in Postgres and
downloadable as CSV from `/members/list`).

## Pages & API

- `/members` — lookup by phone, punch visits, record memberships
- `/members/list` — full ledger + **Members CSV** / **Visits CSV** downloads
- `GET /api/members/lookup?phone=` · `POST /api/members/create` ·
  `POST /api/members/visit` · `GET /api/members/export?what=memberships|visits`
  (all gated by the ops password cookie)

## Business rules

- Plays per visit = `ceil(kids / kidsPerPlay)` — 2 kids on a 1-kid/play plan
  use 2 plays (matches how the counter punches qty 2 manually today).
- Expiry is date-based (IST); the expiry day itself is still usable. Expired
  or used-up memberships can't punch (hard block).
- "Supervised Play Pass": unlimited plays but once per day (hard block) and
  Mon–Fri only (soft block — the manager can force-punch as a goodwill
  exception; expired/used-up stays hard).
- Play deduction is transactional (row lock), so two devices punching the
  same membership at once can't overdraw. If the Swipe punch invoice fails,
  the deduction is rolled back — nothing is silently consumed.
