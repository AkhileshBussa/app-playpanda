# The cash ledger

Swipe knows what was *billed*. It does not know what is in the drawer. The
ledger at [`/ops/ledger`](../src/app/ops/ledger/page.tsx) answers the question
Swipe can't: **how much cash is in the store right now** — and whether what the
counter counted agrees with what the books say it collected.

## How it adds up

```
opening balance (start of the month)
  + cash declared        what the counter counted at close of play
  − cash spent           expenses raised at /ops/expenses and paid in Cash
  − cash taken out       the owner's draw, a bank deposit
  = cash in store
```

Cash only ever moves outward here. Takings come in over the counter and are
declared; nothing else puts money into the drawer, so the form offers no way to
say otherwise — one less field, and one less thing to mistype. (The stored row
still carries a direction and the balance still handles an inward one, should a
row from before this ever turn up.)

The running balance is built from the **declared** figure, never from Swipe.
The drawer is physical: the count is the truth, and Swipe is the expectation.
Putting the two side by side so they can disagree is the entire point.

Online money never touches the drawer, so it sits apart from that sum. It is
declared and tallied for the same reason — a card machine that says one thing
and Swipe another is worth knowing about — but it moves no balance.

## Two tiers, one login

| | Counter (`OPS_PASSWORD`) | Owner (`ADMIN_PASSWORD`) |
| --- | --- | --- |
| Declare a day, and correct one | ✅ | ✅ |
| Log cash taken out | ✅ | ✅ |
| See the balance and the history | ✅ | ✅ |
| **Remove** a logged withdrawal | — | ✅ |
| Set a month's opening balance | — | ✅ |
| What Swipe collected, and the variance | — | ✅ |

The counter's write access stops at the daily entry. It can *record* cash
leaving the drawer — the manager is the one standing there when it does, and
cash that nobody can record is cash the balance never learns about — but it
cannot make that record go away afterwards. Logging money out and erasing the
fact that it went are different acts, and only the second one is dangerous.

Everything else on the page is read-only to the counter.

Both passwords are typed into the same gate; which one you type decides what
you get (see [`src/lib/ops/auth.ts`](../src/lib/ops/auth.ts)). The owner's
password sets both cookies, so admin implies ops and no existing `isOpsAuthed()`
check had to learn about tiers.

The counter can't reconcile a drawer against a number it can't see, so it does
get the balance. What it doesn't get is the Swipe side — and it doesn't get it
*at all*: [`buildLedgerMonth`](../src/lib/ledger/month.ts) takes the tier as an
argument and leaves those figures out of the response, so there is nothing to
find in the network tab.

Neither password is an identity. Anything that needs a name — who counted the
day, who took the cash — asks on the form, exactly as the expenses form does.

## Where each number comes from

| Number | Source |
| --- | --- |
| Declared cash / online | `cash_days` — typed at the counter |
| Cash taken out | `cash_movements` — typed at the counter |
| Opening balance | `cash_months` |
| **Swipe collected** | Live from Swipe, `getCollectionsByDay` |
| **Cash spent** | Live from Swipe's expenses, payment mode `Cash` |

Cash spent is dated by the expense's own **date spent** — the field on the
/ops/expenses form, not the day it was typed in — so a bill entered late still
comes off the drawer on the day the money left it.

The two live ones are deliberately not copied into Postgres. Expenses are
already raised into Swipe from [`/ops/expenses`](../src/lib/staff/expenses.ts)
and Swipe stays the book of record; a second copy here would be one more thing
to drift. It also means the manager has one place to enter an expense, not two.

### The tally counts by payment date

`getCollectionsByDay` buckets money by the day each *payment* was taken, not by
the day its invoice was raised. A bill raised on Friday and settled on Saturday
is in Saturday's drawer, which is where the note physically is. Because Swipe's
`get_transactions` filters on the invoice date, the adapter looks a fortnight
further back than the range asked for so those late settlements are seen at all.

## Months

Each month opens with a balance. Set one and it is **explicit**: pinned, and
never moved by anything. Leave it and it is **carried** — recomputed from the
previous month's close on every read, so correcting a day in March still moves
April, May and the number on the screen today. Carried openings are cached back
to the row and chain back at most 12 months.

September 2026 is the first month, and the ledger started mid-month: its row
carries `starts_on = 2026-09-06`, the day the drawer was first counted, and days
before that are simply not part of the ledger.

## History

Every human change is recorded in `cash_audit`, which is **append-only** —
nothing in the app updates or deletes a row there. A figure that can be
corrected silently is not a ledger, and the correction is often the interesting
part: a day recounted after the owner has already looked at it is exactly what
this exists to show.

The write and its history entry happen in **one transaction**, so there is no
code path that changes a figure without leaving a trace. Either both land or
neither does.

Each entry carries two names, deliberately:

| | |
| --- | --- |
| `changed_by` | typed on the form — a claim |
| `changed_tier` | `counter` or `owner`, from the cookie actually presented — not typeable |

When they disagree, believe the tier.

What is and isn't recorded:

- **Recorded:** declaring a day, correcting one, logging cash out, removing a
  logged withdrawal, setting a month's opening balance.
- **Not recorded:** re-saving a day without changing anything (an accidental
  re-save would bury the real corrections), and carried-forward opening
  balances (derived on every read — machine noise, not a decision).

On the board it's one grey collapsed line per day and one under the opening
balance, saying how many times the figure was edited. "Edited" counts entries
whose action is an update or a deletion — writing a figure down the first time
isn't an edit, and the log doesn't necessarily reach back to a creation, since
figures entered before the log existed have updates with nothing above them.

## What it won't do quietly

- A day up to yesterday with nothing declared is called out by name, because
  the balance is short by whatever came in on it. Today is never "missing" —
  it's still being traded.
- If Swipe's expenses can't be read, the page says so and says the balance
  shown is *before* expenses, rather than showing a confident wrong number.
- Declaring a day again corrects it. There is one row per day, always.

## Tables

Defined with everything else in [`src/lib/db/schema.ts`](../src/lib/db/schema.ts):
`cash_months`, `cash_days`, `cash_movements`, and the append-only `cash_audit`.
All four carry the `environment` stamp, so a figure typed on a preview deploy
or a laptop can never move the real drawer.
