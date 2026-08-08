# Staff tools — attendance, expenses, issues, feedback

Four tools that hang off `/ops`, plus two pages that don't need the ops
password: `/staff` (employees) and `/feedback` (customers).

## Who can do what

There are two credentials, and they're deliberately different things.

| | Credential | Gets you |
|---|---|---|
| **Employee** | their own 4-digit PIN at `/staff` | mark their own attendance, apply for their own leave, report an issue |
| **Manager** | the shared `OPS_PASSWORD` at `/ops` | everything above plus approving leave, expenses, the roster, and every report |

An employee never needs the manager's password to record their own day, and a
leave approval is never "whoever was holding the tablet". The `role` field on
an employee is a **label on the roster** — approving leave is gated on the ops
password, not on the role.

PINs are stretched with scrypt and a per-employee salt, and five wrong tries
freeze that employee for 10 minutes (counted in Redis). A manager resets a
forgotten PIN from **Staff → Manage employees → Edit**, which also clears the
lockout.

---

## 1. Attendance & leave

**Employees** open `/staff`, tap their name, enter their PIN, and get one
button: **Check in**, then later **Check out**. One row per person per IST day;
the dashboard shows hours worked once they've checked out.

### The geofence

Both taps capture the browser's coordinates and **the server** re-checks them
against the playzone — the page can't be trusted to police itself. Beyond
150 m, the entry is refused.

The location is **hardcoded**, in `PLAYZONE` at the top of
[`src/lib/staff/geo.ts`](../src/lib/staff/geo.ts):

```ts
export const PLAYZONE = { lat: 17.3582013, lng: 78.3881378, radiusM: 150 };
```

It is not configuration. There is one Play Panda, its coordinates don't change,
and the one time this *was* an env var the result was a silently disabled check
because nobody had set it in the environment. Edit the constant if the playzone
ever moves.

The coordinates are the Google Maps **place pin** (`!3d…!4d…` in the URL), not
the `@lat,lng` map centre in the same URL — those sit 74 m apart, which would
eat half the radius.

Two deliberate softenings, because indoor GPS is bad:

- A fix is judged by how close it *could* be — `distance − accuracy` must be
  inside the radius. A phone claiming "within 200 m of a point 300 m away" is
  let through rather than punished for poor signal.
- A fix worse than 2 km of accuracy proves nothing either way and is refused
  with a message telling the employee to step near a window.

### The noon alert

From **12:00 IST**, `/ops` shows a banner naming anyone who hasn't marked
attendance. Someone on **approved** leave isn't missing — they're off. Someone
whose leave is still *pending* **is** missing, because nobody has agreed to it
yet. The banner is dismissible and never blocks the session monitor; if the
staff database is unreachable it renders nothing at all.

To move the cutoff, edit `CUTOFF_HOUR` in
[`src/app/api/ops/attendance/alert/route.ts`](../src/app/api/ops/attendance/alert/route.ts).

### Leave

Employees apply from `/staff` → Leave (date range, type, optional reason). It
lands as **pending** on `/ops/attendance` → Leave, where one tap approves or
rejects. Every request ever raised stays listed, the manager's own included.

---

## 2. Expenses

Playzone purchases used to be typed straight into Swipe. They're now raised
from **`/ops/expenses`** — and they still land in exactly the same place, so
nothing about the books changes. **There is no local expenses table**: the page
writes to Swipe and reads straight back, so there's no second copy to drift.

The page shows the current month's total, a per-category breakdown, and every
line; the picker goes back 12 months.

Swipe endpoints (company 2430519), in
[`src/lib/staff/expenses.ts`](../src/lib/staff/expenses.ts):

| Call | Purpose |
|---|---|
| `POST v3/expenses/create` | raise one; returns the `EXP-` serial |
| `POST expenses/get` | list a `DD-MM-YYYY - DD-MM-YYYY` range |
| `POST expenses/get_categories` | the category picker |
| `POST expenses/add_category` | "+ New category…" on the form |

Expenses are recorded as **already paid** against bank_id 1 (HDFC) — which is
what a counter purchase actually is. An expense raised without a category comes
back from Swipe blank with `category_id: -1`; the adapter labels those
**Uncategorised** so they don't show as an empty row.

Auth is shared with the billing adapter (`swipeRequest` in
[`src/lib/billing/swipe.ts`](../src/lib/billing/swipe.ts)) — the same Swipe
session token from Redis, refreshed from pp-billing → Settings.

---

## 3. Issues & repairs

**`/ops/issues`** — six types (Electrical, Plumbing, Cleanliness, Play
equipment, AC, Other), three priorities, an optional photo, and a status of
open → in progress → resolved.

Either credential can *report* — a broken slide shouldn't wait for the manager
to walk over — and the report is attributed to whoever was signed in. Closing
one out is a manager action.

---

## 4. Customer feedback

**`/feedback`** is public, with no ops chrome: the page behind the QR code at
the counter.

The star is saved **on its own request the moment it's tapped**, before
anything else is asked. Someone who taps 2 stars and walks off still tells us
something — and that's exactly the rating we'd otherwise never hear. Then:

- **5 stars** → invited to leave a Google review.
- **Below 5** → asked what could be improved, plus an optional name and phone
  for a callback. It stays private, which is the whole point of asking here
  first.

Set `NEXT_PUBLIC_GOOGLE_REVIEW_URL` to your Google review link. Until it's set,
five-star raters see a note telling the manager to add it.

Everything lands on **`/ops/feedback`**: average, star distribution, and a
"Needs attention" filter for the sub-5-star notes.

---

## Setup

Postgres and Redis are already required by memberships and the ops monitor.
What's new:

| Variable | Needed for | If unset |
|---|---|---|
| `NEXT_PUBLIC_GOOGLE_REVIEW_URL` | the 5-star hand-off | five-star raters see a "not set up" note |
| `BLOB_READ_WRITE_TOKEN` | issue photos, expense bills | upload returns "photo storage isn't set up"; everything else works |

`BLOB_READ_WRITE_TOKEN` comes from **Vercel dashboard → the project → Storage →
Create → Blob**; Vercel injects it. Locally, `vercel env pull .env.local`.
Uploaded blobs are **public** (unguessable URL) because Swipe's attachment
viewer has to be able to read the bill photos too.

Tables (`employees`, `attendance`, `leave_requests`, `maintenance_issues`,
`feedback`) are created automatically on first use, like the membership ones —
no migration step.
