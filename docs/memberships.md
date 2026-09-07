# Memberships (`/members`)

Staff-only counter for PlayPanda memberships (same password as `/ops`).

## How it fits the existing workflow

**The app sells the membership; Swipe follows.** Nothing is billed by hand
first — saving the form is what raises the invoice.

1. Customer picks a plan and pays.
2. Manager fills **`/members/new`** — no lookup needed first; typing the phone
   prefills the customer's name and kids from Swipe (phone number + plan;
   fixed plans are one tap, custom plans set their own plays/hours/validity
   but bill and punch on an existing Swipe product). The amount is prefilled
   from the plan and can be edited, and the payment is taken in the same step
   (Cash / Card / UPI — a sale billed from here is always collected, so there
   is no "pay later" option; only Card offers a reference field). **Created
   on** defaults to today and can be back-dated for a sale taken on an earlier
   day — it moves the membership's place in the ledger, not the Swipe invoice,
   which is always dated today.
3. Saving **creates the sale invoice in Swipe** on the plan's sale product,
   records the payment against it, mirrors both into our own ledger, and
   stores the membership — in that order, so a duplicate warning or a
   validation error never leaves a stray invoice behind.
4. When the member visits, the manager looks up the phone number on
   `/members` — it shows plays used, plays allowed, plays left, and expiry.
5. If plays are left, **Punch a visit** deducts them (2 kids on one visit =
   2 plays, unless the plan covers more kids per play) and…
6. …creates a **₹0 invoice in Swipe** with the plan's Punch product — so the
   visit shows up in Swipe history and as a teal MEMBER session on `/ops`,
   exactly like manually-punched visits do today.

### Sales billed in Swipe by hand

The form's **Already billed** tab keeps the old path for a sale that was
raised in Swipe directly (billed on an earlier day, or a walk-up someone
invoiced there). It picks from a list of today's Swipe membership sales — a
fixed plan shows only invoices carrying that plan's product, a custom plan
shows all of them — and typing the number stays available for older sales or
when Swipe is unreachable. Nothing is billed or collected in this mode.

### When something half-lands

The sale invoice is real the moment Swipe accepts it, so failures after that
point are reported rather than hidden:

- **payment didn't record** — the membership is still saved and the counter is
  told which invoice to collect on from the ops board. That membership also
  carries a red **₹X to collect** tag wherever it's listed, until the money
  lands, so a half-finished sale can't quietly go unnoticed.
- **membership didn't save** — the error names the invoice number, so the
  manager records it via **Already billed** with that number instead of
  billing a second one.

Every membership and visit is stored in **Postgres** (source of truth) and
mirrored to a **Google Sheet** (best-effort, for easy viewing).

## Plan catalog

Defined in `src/lib/members/plans.ts`, mirroring the Swipe catalog
(company 2430519):

| Plan | Sale product | Punch product | Plays | Hrs/play | Validity | Price |
|---|---|---|---|---|---|---|
| Fun Five Pass | 6 | 160 | 5 | 2 | 6 mo | ₹2,499 |
| Fun Ten Pass | 199 | 200 | 10 | 1 | 6 mo | ₹3,499 |
| Panda Pro 12 | 7 | 162 | 12 | 2 | 12 mo | ₹4,999 |
| Panda Max 25 | 8 | 161 | 25 | 2 | 12 mo | ₹7,999 |
| Supervised Play Pass | 9 | 163 | Unlimited · 1/day · Mon–Fri | 4 | 1 mo | ₹5,999 |

Plays/hours/validity were read from each product's Swipe custom fields
("Number of Plays", "Number of Hours", "Validity (in Months)"). If the
catalog changes in Swipe, update `plans.ts` to match.

The sale product is what the app bills the purchase on; the punch product is
what each visit is punched against. A **custom plan** has no catalogue entry
of its own, so it borrows the pair belonging to the punch product it's mapped
to — the invoice line carries the custom plan's own name, price and terms, and
Swipe still files it under the membership categories the ops board and the
sales pick-list rely on.

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
keeps working and rows simply don't mirror (they're always in Postgres, and
`/api/members/export?what=memberships|visits` still returns CSV on demand).

## Pages & API

Punching and creating are deliberately separate pages: punching needs a
lookup, creating does not.

- `/members` — **Punch a visit**: look up by phone, see plays left, punch.
  Deleted memberships are left out of the lookup — nothing can be punched
  against them.
- `/members/new` — **New membership**: standalone form, no lookup required
- `/members/list` — **All members**: the live ledger. Deleted memberships are
  kept out of it (and out of the counter lookup) and live behind a
  **Deleted (n)** tab
  (`/members/list?show=deleted`), which shows each one's reason. The tab pair
  only appears once something has been deleted. No download buttons; for a
  bulk export use the Google Sheet, or hit `/api/members/export` (see below).
- `/members/<id>` — one membership: its terms, every punch, and deletions.
  Reached by clicking a membership anywhere it's listed.

## Deleting

Nothing is ever removed from the database. Deleting a membership or a punch
marks the row with a timestamp and a **required reason**, and it keeps showing
up (struck through, tagged `Deleted`, with the reason) so the history stays
readable — on the membership's own page and under the **Deleted** tab of
`/members/list`. It is filtered out of the two working views: the main ledger
and the counter's punch lookup. Both actions live on the membership's own page.

- **Deleting a punch gives its plays back** — every plays-used total ignores
  deleted rows — so it's the right fix for a mis-punch.
- **Deleting a membership** blocks further punches and frees its sale invoice
  for re-linking. Punches already made are left as they are.
- **Swipe is never touched.** A punch's ₹0 invoice — and the sale invoice —
  stay in Swipe; the UI names them so the manager can delete or credit them
  there if they want to.
- Deletions are also appended to a **Deletions** tab in the Google Sheet
  (the other tabs are append-only history). Re-run
  `npx tsx scripts/setup-sheets.ts` once to create that tab.
- `GET /api/members/lookup?phone=` · `POST /api/members/create`
  (bills the sale, takes the payment, records the membership) ·
  `POST /api/members/visit` · `GET /api/members/sale-invoices` ·
  `GET /api/members/export?what=memberships|visits`
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
