# Stock

Swipe already keeps the count. Every sale decrements a product, every purchase
invoice puts it back, and it has done so since long before this page existed.
So [`/ops/stock`](../src/app/ops/stock/page.tsx) is a **window onto that**, not
a second inventory — a stock number kept in two places is a stock number that
disagrees with itself by Friday. Same rule expenses and purchases follow.

## What the page is for

| | Counter | Owner |
| --- | --- | --- |
| What's on hand, what's running low | ✅ | ✅ |
| Stock in and out, per product | ✅ | ✅ |
| Add or edit a product | ✅ | ✅ |
| Cost, margin, and prices on movements | — | ✅ |
| Record stock received | — | ✅ |

Cost and margin are stripped from the counter's *response*, not hidden in its
UI.

**The counter can change the catalogue.** A delivery arrives with a new line on
it, or a supplier's price moves, and the person standing there is the one who
knows; making them wait for the owner means the catalogue goes stale, which is
worse than the risk of a mistyped cost. The safeguard isn't a locked door — it's
that every change is recorded with who made it.

Receiving stays owner-only, because it raises a real financial document. Easy
to relax if deliveries turn out to arrive when only the counter is there.

## One product's story

Tapping a product shows two things, kept apart because they answer different
questions and come from different places.

**Stock in and out** is Swipe's own inventory timeline (`inventory/timeline`),
so every line carries a real `INV-` or `PINV-` serial and a running balance —
the count and the paperwork can be checked against each other. Nothing here is
inferred by this app.

**Changes to this product** is ours, in `product_audit`, because Swipe keeps no
history and cannot say who moved a price. Append-only, same doctrine as the
cash ledger: nothing updates or deletes a row. Each entry carries the typed
name beside the tier proved by the cookie, and re-saving the form untouched
records nothing — an accidental re-save would bury the edits that matter.

The audit row is written after Swipe accepts the change, never before, and
best-effort: a Postgres hiccup must not fail an edit Swipe has already made, or
the two would disagree about what the product is.

## The kitchen is not inventory

The catalogue holds 147 stock-type products, but 86 of them are the café menu
(categories **Restaurant** and **Raghavendra**). Those are dishes made to order
from ingredients: Swipe decrements them on every sale and nothing ever stocks
them back, so they drift further negative with each one sold. At the time of
writing 60 of the 86 are below zero, dragging the catalogue's total stock value
to about **minus fifty thousand rupees**.

They're excluded. What's left is 61 real retail lines worth about ₹9,658 — a
number that means something. It's a deny-list rather than an allow-list, so a
new retail line shows up by itself and a new kitchen category announces itself
by going negative.

## Three data problems, stated not hidden

None of these is something the page can fix, so it says them out loud rather
than letting you infer them from odd-looking rows:

- **Nine products below zero** — sold more often than stocked in.
- **Thirty-nine without a usable cost** — 25 have none recorded; 14 have a cost
  at or above their selling price (the account has socks whose "average
  purchase price" is their retail price). Where a cost can't be trusted, no
  margin is shown at all rather than a made-up one.
- **No reorder levels anywhere** — without one, nothing can ever be flagged as
  running low.

The last two are fixable from the edit form, which is why cost and reorder
level are first-class fields on it rather than buried under "advanced".

## Swipe endpoints, all undocumented

None of these appear in Swipe's web bundle under a name you could guess. They
were taken from real requests and verified live.

| Call | Purpose |
|---|---|
| `POST v3/products/get` | the catalogue, with quantities and costs |
| `POST product/get_details` | one product's full record |
| `POST product/add` | **create only** — multipart form |
| `POST product/update` | **edit** — multipart, same fields plus the id |
| `POST utils/get_prefix_seral_number` | next `PINV-` serial (`document_type: "purchase"`) |
| `POST v3/doc/create` | the purchase invoice — same endpoint bookings use |
| `POST v3/payments/create_payment` | the payment, `payment_type: "out"` |
| `POST inventory/timeline` | one product's stock movements, mapped to documents |

Three things learnt the hard way, all worth not re-discovering:

- **`product/add` is create-only.** Posting an edit to it, id and all, is
  refused with "Product with this name already exists" — it never looks at the
  id.
- **An edit is a full replacement.** Whatever the form omits is lost, so
  `updateProduct` reads the product back and overlays the caller's changes on
  the real record. Opening stock, the price-with-tax flag and the custom
  columns are round-tripped for exactly that reason.
- **A purchase's party is `customer.vendor_id`, not `customer.id`.** The latter
  is the party row attached to that one document and differs on every purchase;
  passing it is refused with "Party not found or deleted".

There is also a `v3/products/update`, found by guessing endpoint names. It takes
a `products` array, rejects most fields as unknown, and appears nowhere in the
bundle. Presumably bulk edit. Not used.

## Receiving stock

Raising a purchase invoice — rather than an expense — is the entire point.
Swipe puts the quantity back on the product, and the books treat the money as
inventory rather than spend. Buying socks is an asset swap; its cost is booked
when the socks sell. See [ledger.md](./ledger.md) for the other half: a
purchase paid in cash comes off the drawer on its own line, never folded in
with expenses.

Vendors are the ones already bought from. Swipe exposes no endpoint that lists
vendor parties, so the list is derived from a year of purchase invoices — no
loss in practice, since stock comes from the same handful of suppliers. A
genuinely new supplier has to be added in Swipe once, and the form says so.

Verified end to end on 2026-09-06: PINV-16 raised for one unit at ₹1 paid in
cash, product quantity 0 → 1, the ₹1 appearing against that day on the cash
ledger; then the document was cancelled and both reversed cleanly.
