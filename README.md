# Play Panda — Book & Pay

Operational app for Play Panda. First use case: **walk-in QR booking** — when there's a rush at the
playzone, customers scan a QR, fill a 30-second form, pay online, and show the invoice number at
the counter.

## How it works

```
Customer scans QR → / (booking form: name, phone, kids, package, socks — live total)
        │ Book now
        ▼
POST /api/checkout → billing.createBooking()
                     1. find/create customer (by phone)
                     2. fetch next serial (INV-NNNN)
                     3. create invoice with a 4-digit validation code in the
                        invoice's "Validation Code" document custom header
        │
        ▼
redirect to /success/<number>   (bare invoice number in the URL — no prefix)
        │
        ▼
/success/[invoice] (server component) → billing.getBookingByInvoiceNumber()
        fetches the invoice from the backend by number, reads back the
        Validation Code + details → renders. Reload-safe; no query params.
```

The confirmation screen is driven entirely by the billing backend (source of
truth), so it survives reloads and shared links — not dependent on ephemeral
URL params.

**Online payment is not live yet** (`NEXT_PUBLIC_PAYMENTS_ENABLED="false"`). Bookings create the
invoice in Swipe (unpaid) and the customer pays at the counter, where the manager validates the
4-digit code against the invoice. When Razorpay goes live, the payment gets collected and then
recorded in Swipe via `v3/payments/create_payment` (already wired in `/api/payment/confirm`,
dormant until the flag is flipped on).

Everything runs through **Swipe's own internal API** (`app.getswipe.in/api`) — the exact endpoints
and payloads the Swipe web app itself uses (captured from the live app) — so invoices land in
Swipe billing identically to counter billing.

**Why not the partner API?** Swipe's public partner API needs a separately-generated token, and
the session token we already have (pp-billing's, in Redis) is rejected there (401). The internal
API accepts that token, so we reuse pp-billing's existing, auto-refreshed credential.

## Swipe setup

- **Auth:** the app authenticates with the Swipe session token pp-billing keeps in Upstash Redis
  under `swipe:token` (refreshed by pasting the Swipe web app's `accessToken` into pp-billing's
  `/settings` page). The Upstash creds (`KV_REST_API_URL` / `KV_REST_API_TOKEN`) are carried over
  from pp-billing; `SWIPE_API_TOKEN` is an env fallback.
- **Payment toggle (`NEXT_PUBLIC_PAYMENTS_ENABLED`):** currently `"false"` (online payment pending
  on Razorpay's side). Bookings create the invoice in Swipe (unpaid) and the button reads
  **Book now** → "pay at the counter" success page. When Razorpay is live, flip to `"true"`, wire
  the Razorpay collection in the form, and the confirm route records the payment. It's a
  `NEXT_PUBLIC_` var, so restart the dev server / redeploy after changing it.
- **Health check:** `GET /api/swipe/health` — read-only; confirms the token authenticates against
  the internal API. (Verified working: company 2430519.)

Catalog mirrors the **real products** in the Swipe account (company 2430519):

| Swipe id | Product | Price (incl. GST) | GST |
| --- | --- | --- | --- |
| 2 | Mini Adventure - 1hr | ₹499/kid | 18% |
| 3 | Panda's Favorite - 2hr | ₹699/kid | 18% |
| 4 | Panda Explorer Pass - 3hr | ₹799/kid | 18% |
| 129 | Extra Adult | ₹199 | 18% |
| 181 | Socks - New - Size 2 (kids) | ₹49 | 18% |
| 134 | Socks Adults Size - 4 | ₹69 | 5% |

If prices change in Swipe, mirror them in [src/lib/pricing.ts](src/lib/pricing.ts).

**Entry & socks policy (surfaced in the form):**
- **One adult enters free with every child.** Adults beyond that are billed as *Extra Adult*
  (₹199, Swipe id 129) via the "Extra adults" stepper.
- **Grip socks are mandatory** for everyone on the floor (kids & adults). The form labels them
  Required and defaults the counts to match (kids socks = kids; adult socks = 1 accompanying
  parent + each extra adult), but lets customers lower them if they bring their own.

**Kids' names & prefill:**
- Optional single-line "Kids' names" field (comma-separated) inside the Kids card — kept short by
  design.
- On a valid phone, the form prefills the customer's name + kids from Swipe (read via
  `get_details`, from the `Child 1..4` custom fields — ids 3/5/7/9 in this account). Returning
  families barely type anything.
- On booking, kid names are written to the customer's `Child N` custom fields (new customers) so
  they feed the same data pp-billing reads. There are only 4 Child slots.

## Billing backend abstraction

All backend communication goes through a **provider interface** so Swipe can be swapped for our own
backend later without touching routes or UI:

- [src/lib/billing/types.ts](src/lib/billing/types.ts) — the `BillingProvider` port (domain terms
  only: customers, bookings, payments; no invoice hash ids / doc counts leak across it).
- [src/lib/billing/swipe.ts](src/lib/billing/swipe.ts) — the Swipe adapter (all `app.getswipe.in`
  calls live here).
- [src/lib/billing/index.ts](src/lib/billing/index.ts) — **the single swap point**:
  `export const billing = swipeBilling`. To move backends, write a new adapter implementing
  `BillingProvider` and change this one line.

**Swipe endpoints the adapter uses** (POST `app.getswipe.in/api/<prefix>/<action>`, Bearer session
token, mirroring the web app's own requests):

| Call | Purpose |
| --- | --- |
| `v2/customer/check_existing_party_with` | find a customer by phone |
| `v2/customer/get_details` | read a returning customer's name + kids (prefill) |
| `v2/customer/add` | create a customer (phone as number; kids in `custom_fields`, keyed by field id) |
| `utils/get_document_prefix` | read the default invoice prefix (`INV-`) |
| `utils/get_prefix_seral_number` | fetch the next invoice number (serial is client-computed) |
| `v3/doc/create` | create the invoice; retries on `DUPLICATE_DOC_SERIAL_NUMBER` warning with the server-suggested number |
| `v2/doc/get_transactions` | find an invoice by serial (`search_type: "serial_no"`, exact match) |
| `v2/doc/get_invoice` | read invoice detail (customer, total, status, item custom columns) |
| `v3/payments/create_payment` | record a payment against the invoice — dormant until Razorpay is live |

The **validation code** lives in the invoice's "Validation Code" document custom header
(`header_id` 1) — and nowhere else. It's written on create and read back on the confirmation
screen.

## Setup

1. In `.env.local`: the Upstash vars are already carried over from pp-billing. No Razorpay keys
   needed.
2. `npm run dev`, open `/api/billing/health` to verify Swipe auth, then do a test booking — it
   creates a real (unpaid) invoice in Swipe.
3. Point the printed QR code at the deployed URL.

## Brand

UI follows the Play Panda brand guidelines (see `../playpanda/Play Panda_Brand Guidelines.pdf`):
Hank Rnd typeface (`public/fonts/`), the 8-color palette + cream (tokens in
[globals.css](src/app/globals.css) — **no colors outside the palette**), chunky `rounded-chunk`
cards with flat offset shadows, pill CTAs with press-down states, logo + mascot from the
marketing site's `public/`.

## Project map

| Path | What it does |
| --- | --- |
| `src/components/BookingForm.tsx` | The customer-facing booking form |
| `src/app/success/[invoice]/page.tsx` | Confirmation screen — fetches the booking by invoice number, shows the code |
| `src/app/api/checkout/route.ts` | Find/create customer + create invoice (with validation code) |
| `src/app/api/payment/confirm/route.ts` | Records a payment against the invoice (dormant until Razorpay is live) |
| `src/app/api/customer/lookup/route.ts` | Read-only prefill lookup by phone |
| `src/app/api/billing/health/route.ts` | Read-only billing-backend auth diagnostics |
| `src/lib/pricing.ts` | Catalog: sku, name, price, GST — single source of truth |
| `src/lib/billing/` | Billing provider port + Swipe adapter (see above) |

## Notes for operations

- Abandoned checkouts leave an **unpaid** invoice in Swipe (created before payment). Filter by
  payment status in Swipe; cancel stale ones from the dashboard.
- If bookings fail auth, refresh the Swipe token via pp-billing `/settings` (both apps read it
  from Redis). Check `GET /api/swipe/health`.
- The success page is rendered from confirmed data, but the manager's source of truth is Swipe —
  search the invoice number or customer phone there if anything looks off.
