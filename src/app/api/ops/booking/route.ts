import { NextResponse } from "next/server";
import { z } from "zod";
import { isOpsAuthed } from "@/lib/ops/auth";
import { billing } from "@/lib/billing";
import { PAYMENT_METHODS, type EditRefusalReason } from "@/lib/billing/types";
import {
  computeQuote,
  EXTRA_30_MIN,
  EXTRA_ADULT,
  PACKAGES,
  SOCKS,
  type PackageId,
} from "@/lib/pricing";
import {
  editInvoiceMirror,
  quoteMirrorLines,
  recordInvoice,
  recordPaymentMirror,
} from "@/lib/invoices/db";
import { dbConfigured } from "@/lib/pg";
import { bumpBoard } from "@/lib/ops/state";

export const dynamic = "force-dynamic";

/**
 * Book a walk-in at the counter: the same invoice the app creates, plus the
 * payment if it's already been taken.
 *
 * Two things this deliberately does NOT do, both because the counter's version
 * of a booking differs from the customer's in exactly these ways:
 *
 *  - No validation code. The code exists so staff can check a family in against
 *    a booking made elsewhere, and the ops monitor holds a session at "waiting"
 *    while one is present. A walk-in is at the desk, so its timer should run
 *    from the invoice — see CreateBookingInput.validationCode.
 *  - No new customer for a number we already know. The billing adapter looks the
 *    phone up and reuses the party, so re-booking a regular family adds an
 *    invoice against the customer they already have, never a duplicate of them.
 */
/** The selection + customer — everything a booking IS, shared by create and edit. */
const bookingFields = {
  name: z.string().trim().min(2, "Enter the customer's name").max(60),
  phone: z.string().regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit mobile number"),
  packageId: z.enum(PACKAGES.map((p) => p.id) as [PackageId, ...PackageId[]]),
  kids: z.number().int().min(1).max(15),
  extraAdults: z.number().int().min(0).max(20),
  childSocks: z.number().int().min(0).max(30),
  adultSocks: z.number().int().min(0).max(30),
  /** Half-hour extensions. Only the edit sheet sends it; a new booking picks a
   *  longer package instead, so it defaults to none. */
  extra30: z.number().int().min(0).max(20).default(0),
  kidNames: z.array(z.string().trim().max(40)).max(15).default([]),
};

const bookingSchema = z
  .object({
    ...bookingFields,
    /** True = money already taken; record it against the invoice right away. */
    paid: z.boolean().default(false),
    method: z.enum(PAYMENT_METHODS).optional(),
    transactionRef: z.string().trim().max(60).optional(),
  })
  .refine((v) => !v.paid || v.method != null, {
    message: "Pick how they paid",
    path: ["method"],
  });

export async function POST(req: Request) {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let input: z.infer<typeof bookingSchema>;
  try {
    input = bookingSchema.parse(await req.json());
  } catch (err) {
    const message = err instanceof z.ZodError ? err.issues[0]?.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  // Priced server-side from the same catalogue the customer form uses, so a
  // counter booking and an app booking of the same selection cost the same.
  const quote = computeQuote(input);
  const kidNames = input.kidNames.map((n) => n.trim()).filter(Boolean);

  let booking;
  try {
    booking = await billing.createBooking({
      customer: { name: input.name, phone: input.phone, kidNames },
      lines: quote.lines,
    });
  } catch (err) {
    console.error("counter booking failed:", err);
    return NextResponse.json(
      { error: "Couldn't create the invoice in Swipe — please try again" },
      { status: 502 }
    );
  }

  // Mirror into our own ledger — best-effort, the booking must never fail on it.
  if (dbConfigured()) {
    await recordInvoice({
      number: booking.invoiceNumber,
      source: "counter",
      customer: {
        phone: input.phone,
        name: input.name,
        kidNames: kidNames.join(", "),
        swipeRef: booking.customerRef ?? null,
      },
      swipeRef: booking.docRef ?? null,
      grossInr: quote.gross,
      discountInr: 0,
      netInr: quote.total,
      lines: quoteMirrorLines(quote.lines),
    }).catch((err) => console.error("counter invoice mirror failed:", err));
  }

  await bumpBoard();

  // Payment is a second call, and it can fail on its own. The invoice exists
  // either way, so a failure here reports "booked but not recorded" rather than
  // losing the booking — the card's own Collect button is then the way in.
  if (input.paid) {
    try {
      await billing.recordPayment({
        ref: booking.ref,
        amount: quote.total,
        method: input.method!,
        transactionRef: input.transactionRef,
      });
      if (dbConfigured()) {
        await recordPaymentMirror({
          invoiceNumber: booking.invoiceNumber,
          amountInr: quote.total,
          method: input.method!,
          transactionRef: input.transactionRef,
          amountDueAfter: 0,
        }).catch((err) => console.error("counter payment mirror failed:", err));
      }
    } catch (err) {
      console.error("counter booking payment failed:", err);
      return NextResponse.json(
        {
          invoiceNumber: booking.invoiceNumber,
          total: quote.total,
          paid: false,
          amountDue: quote.total,
          warning: `${booking.invoiceNumber} was created, but the payment didn't record. Collect it from the card.`,
        },
        { status: 207 }
      );
    }
  }

  return NextResponse.json({
    invoiceNumber: booking.invoiceNumber,
    total: quote.total,
    paid: input.paid,
    amountDue: input.paid ? 0 : quote.total,
  });
}

// ── Editing a booking after it's made ────────────────────────────────────────

/** Counter-facing copy for an edit refusal. */
const EDIT_REFUSAL_COPY: Record<EditRefusalReason, string> = {
  "not-found": "Couldn't find the invoice behind this card.",
  "shared-invoice": "This invoice covers more than one session card — edit it in Swipe.",
  unsupported: "This invoice has items the booking form doesn't offer — edit it in Swipe.",
  discounted:
    "A discount has been applied, and editing would re-price everything at full rates — adjust it in Swipe instead.",
  "refund-needed":
    "They've already paid more than that new total — a refund has to be sorted in Swipe.",
};

const editSchema = z.object({
  /** The ops session id behind the card being edited. */
  id: z.string().trim().min(1),
  ...bookingFields,
});

/**
 * What the edit sheet opens with: the booking's current selection, read back
 * from the invoice itself rather than the board (which may be 30s stale), plus
 * whether an edit could land at all — a discounted or hand-built invoice says
 * "no, and why" here, before anyone retypes anything.
 */
export async function GET(req: Request) {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const id = new URL(req.url).searchParams.get("id")?.trim();
  if (!id) {
    return NextResponse.json({ error: "Missing session id" }, { status: 400 });
  }

  try {
    const state = await billing.getBookingEditState(id);
    if (!state.editable) {
      const reason = state.refused ?? "not-found";
      return NextResponse.json({
        editable: false,
        invoiceNumber: state.invoiceNumber,
        reason: EDIT_REFUSAL_COPY[reason],
      });
    }

    // Quantities → the creation form's selection. The adapter has already
    // guaranteed exactly one package line and catalogue-only skus.
    const q = state.quantitiesBySku ?? {};
    const pkg = PACKAGES.find((p) => q[p.sku]);
    if (!pkg) {
      return NextResponse.json({
        editable: false,
        invoiceNumber: state.invoiceNumber,
        reason: EDIT_REFUSAL_COPY.unsupported,
      });
    }

    return NextResponse.json({
      editable: true,
      invoiceNumber: state.invoiceNumber,
      selection: {
        packageId: pkg.id,
        kids: q[pkg.sku],
        extraAdults: q[EXTRA_ADULT.sku] ?? 0,
        childSocks: q[SOCKS.child.sku] ?? 0,
        adultSocks: q[SOCKS.adult.sku] ?? 0,
        extra30: q[EXTRA_30_MIN.sku] ?? 0,
      },
      total: state.total,
      amountDue: state.amountDue,
    });
  } catch (err) {
    console.error("booking edit state failed:", err);
    return NextResponse.json({ error: "Couldn't read the booking from Swipe" }, { status: 502 });
  }
}

/**
 * Edit a booking after it's made — everything the creation card sets, settable
 * again: customer, kids' names, package, and quantities. The invoice is
 * rewritten in place in Swipe (same serial, same document), payments already
 * taken stay attached, and whatever the new total leaves outstanding shows on
 * the card with its usual Collect button.
 *
 * Payment state itself is deliberately NOT edited here: recording money is the
 * card's Collect flow, and un-recording money is a books correction that
 * belongs in Swipe, not behind a board tap.
 */
export async function PATCH(req: Request) {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let input: z.infer<typeof editSchema>;
  try {
    input = editSchema.parse(await req.json());
  } catch (err) {
    const message = err instanceof z.ZodError ? err.issues[0]?.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  // Priced server-side from the same catalogue as creation, so an edited
  // booking costs exactly what the same selection would have cost new.
  const quote = computeQuote(input);
  const kidNames = input.kidNames.map((n) => n.trim()).filter(Boolean);

  let result;
  try {
    result = await billing.editBooking({
      sessionId: input.id,
      customer: { name: input.name, phone: input.phone, kidNames },
      lines: quote.lines,
    });
  } catch (err) {
    console.error("booking edit failed:", err);
    return NextResponse.json(
      { error: "Couldn't update the invoice in Swipe — nothing was changed" },
      { status: 502 }
    );
  }

  if (!result.edited) {
    const reason = result.refused ?? "not-found";
    return NextResponse.json(
      { error: EDIT_REFUSAL_COPY[reason], refused: reason },
      { status: 409 }
    );
  }

  // Mirror the new shape into our own ledger — best-effort, like creation.
  if (dbConfigured()) {
    await editInvoiceMirror({
      swipeRef: result.docRef ?? input.id,
      customer: {
        phone: input.phone,
        name: input.name,
        kidNames: kidNames.join(", "),
        swipeRef: result.customerRef ?? null,
      },
      totalInr: result.total ?? quote.total,
      lines: quoteMirrorLines(quote.lines),
    }).catch((err) => console.error("booking edit mirror failed:", err));
  }

  await bumpBoard();

  const amountDue = result.amountDue ?? result.total ?? quote.total;
  return NextResponse.json({
    invoiceNumber: result.invoiceNumber,
    total: result.total ?? quote.total,
    amountDue,
    paid: amountDue <= 0,
  });
}
