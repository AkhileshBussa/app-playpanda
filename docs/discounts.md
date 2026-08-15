# Discounts (`/ops/discounts`)

Discount codes for self-checkout, and a way to give a discount at the counter
when a family asks — replacing the current practice of typing a discount into
the Swipe invoice by hand, where nothing about it gets recorded.

## How it fits the existing workflow

**Self-checkout, family has a code**

1. Family types the code on the booking form and taps Apply. The server prices
   it and the total updates; nothing is spent yet.
2. They book — paying online **or** at the counter, the code applies either
   way — and the Swipe invoice is created **already discounted**.
3. The code is spent at that moment (see "When a code is spent" below).
4. Paying online: the Razorpay order is for the discounted amount, and carries
   `discount_code` / `discount_amount` in its notes so a discounted booking is
   recognisable from the Razorpay dashboard alone.

**Counter, family asks on the spot**

1. On `/ops`, the session card gets a **% Off** button beside Collect.
2. Staff either enter a one-off amount (`₹100` or `10%`) with a reason, or
   apply an existing code. They pick their name from the roster.
3. The Swipe invoice is **re-priced in place** and the discount is written into
   its notes with the code and who applied it.
4. The sheet hands straight over to Collect payment with the new balance.

Both paths write to Postgres, which is the only place that can answer "has this
single-use code been used?".

## Switching the customer side on and off

`NEXT_PUBLIC_DISCOUNT_CODES_ENABLED="true"` puts the code box on the booking
form and lets `/api/checkout` honour a typed code. Anything else — **including
unset** — and self-checkout behaves as if codes don't exist: no box, and
`/api/discounts/check` answers "that code isn't valid" so a hand-made request
gets nowhere either.

Opt-in rather than opt-out (the opposite of `NEXT_PUBLIC_PAYMENTS_ENABLED`):
showing customers a code box means starting an offer, and a deploy shouldn't
decide that by accident.

**The counter is never gated by it.** Staff can always discount an invoice from
`/ops` and manage codes on `/ops/discounts` — including codes customers can't
yet type themselves. Discounting at the desk is what already happens every week;
this flag only controls whether families can do it for themselves.

Being `NEXT_PUBLIC_`, it's inlined at build time — changing it needs a redeploy.

## The three kinds of code

Set on the create form; stored as two limit columns.

| Mode | Means | `total_limit` | `per_customer_limit` |
|---|---|---|---|
| Unlimited | Anyone, any number of times | — | — |
| Per customer | Capped per mobile number | — | N |
| Single use | One redemption, across everyone | 1 | — |

Plus: percent or flat, an optional cap on a percentage, an optional minimum
booking value, an optional end date, and which checkouts it works on
(self-checkout, counter, or both).

Codes are **paused, never deleted** — spent codes still have redemptions
pointing at them, and the ledger has to keep reading correctly.

## When a code is spent

A redemption is written when the **discounted invoice is created**, not when the
money arrives. That's the moment the discount is actually granted: if the family
abandons Razorpay afterwards, they still owe the reduced amount at the counter,
so the code is rightly spent.

It's given back in exactly two cases:

- the invoice write failed, so the booking never happened;
- the booking was cleared off `/ops` as a **no-show** and its invoice cancelled.

Both flip the redemption to `released`, which excludes it from every limit
check. There is no expiry sweeper and no cron — nothing to go stale.

Limits are enforced under `SELECT … FOR UPDATE` on the code row, so two families
can't both spend the last use of a single-use code.

## How the money is taken off

`applyDiscount()` in `src/lib/pricing.ts` scales **every line's tax-inclusive
unit price** by the same ratio, rather than subtracting a lump sum at the bottom.

The catalogue spans two GST slabs (18% on play and extra adults, 5% on adult
socks). A single deduction at the bottom would have to be apportioned across
those slabs by someone; doing it proportionally at the line keeps each slab's
taxable value correct by construction, and matches the treatment of a discount
given at the time of sale.

The recorded discount is derived from the **summed lines**, not from the nominal
figure, so the invoice, the Razorpay order and the ledger can never disagree by
a paisa. It can land a few paise off the nominal — that's the price of the three
always matching.

## Where each thing is recorded

| | Swipe invoice | Razorpay | Postgres |
|---|---|---|---|
| Discounted line prices | ✅ | — | ✅ (gross/discount/net) |
| Code used | invoice notes | order notes | ✅ |
| Who applied it (counter) | invoice notes | — | ✅ |
| Payment ↔ discount link | payment note / UTR | order + payment id | ✅ both ids |
| Usage limits | — | — | ✅ only here |

## Files

| Path | What |
|---|---|
| `src/lib/discounts/types.ts` | Domain types, usage modes, refusal messages |
| `src/lib/discounts/db.ts` | Codes, redemptions, limit enforcement |
| `src/lib/pricing.ts` | `applyDiscount`, `formatInr` |
| `src/app/api/discounts/check/route.ts` | Public: price a code (no redemption) |
| `src/app/api/checkout/route.ts` | Self-checkout: re-check, spend, discount invoice |
| `src/app/api/ops/discounts/route.ts` | List / create / pause codes, redemption ledger |
| `src/app/api/ops/discounts/apply/route.ts` | Counter: discount an existing invoice |
| `src/components/ops/DiscountBoard.tsx` | The `/ops/discounts` page |
| `src/components/ops/ApplyDiscountSheet.tsx` | The counter's % Off sheet |
| `src/lib/billing/swipe.ts` | `applyInvoiceDiscount` + `rewriteInvoiceDiscounted` |

Needs `DATABASE_URL` (same Postgres as memberships and staff tools). The two
tables are created on first use by the usual `onceSchema` block — no migration
step. With no database configured, codes simply don't exist: the booking form
says "that code isn't valid" rather than looking broken.

## How the Swipe invoice edit works (verified 2026-08-12)

Swipe has no discrete edit endpoint. A document is edited by POSTing the **whole
document** back to `v3/doc/create` with its **numeric `id`** set — that field is
the only thing separating an edit from a create.

Verified live on a throwaway booking (INV-1886, since deleted): the invoice went
₹2,235 → ₹2,011.50 at self-checkout and then → ₹1,720.34 from the counter, all
under the same serial, the same `new_hash_id`, and the same numeric id. Two
things worth not re-discovering:

- **The payload's shape is validated strictly.** Adding `hash_id`,
  `new_hash_id`, or `is_edit` at the top level — all of which appear in Swipe's
  own *read* payloads — rejects the entire request with
  `SCHEMA_VALIDATION_ERROR`. Send the create payload plus `id`, nothing else.
- **An edit is a full replacement: anything omitted is lost.** That's why the
  Validation Code document header and the kid-name notes are re-sent every time.
  Re-sent, they survive — which also settles the old open question about whether
  edits wipe `document_custom_headers`. They don't, if you send them.

`roundoff: 1` does **not** round a discounted total: Swipe stored ₹2,011.50 and
₹1,720.34 to the paise. No whole-rupee constraint is needed.

The returned serial is still checked. If a future Swipe ever ignores `id` and
mints a new document, the stray is deleted again and the counter is told the
discount couldn't be applied — a refusal to act on, never a duplicate left in
the books.

Also confirmed in the same run: the ops session id and play-session parsing
survive an edit (so the board and check-in keep working), the per-customer limit
refuses a second use, and cancelling the invoice releases the redemption.

### Still unexercised

- The counter flow through `/api/ops/discounts/apply` **as an HTTP request** —
  the adapter and the ledger calls it composes were driven directly, since the
  route sits behind the ops password. Worth one click through `/ops` → % Off.
- A real online **payment** on a discounted booking, so `rzp_payment_id` gets
  filled in by `/api/payment/verify` (the order and its notes are verified; the
  payment leg shares the existing, separately-tested path).
