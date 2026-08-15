import { NextResponse } from "next/server";
import { z } from "zod";
import { isOpsAuthed } from "@/lib/ops/auth";
import { billing } from "@/lib/billing";
import { dbConfigured } from "@/lib/pg";
import {
  discountAmountFor,
  evaluateCode,
  finalizeRedemption,
  redeem,
  releaseRedemption,
} from "@/lib/discounts/db";
import { DISCOUNT_KINDS, DiscountError } from "@/lib/discounts/types";
import type { DiscountRefusalReason } from "@/lib/billing/types";
import { applyDiscountMirror, findInvoiceIdByNumber } from "@/lib/invoices/db";

export const dynamic = "force-dynamic";

/**
 * Discount an invoice at the counter — the family who booked on the app and then
 * asked, which is how most Play Panda discounts actually happen.
 *
 * Either a code (`code`) or a one-off grant (`kind` + `value` + `reason`): a
 * manager saying "₹100 off" is a real discount and belongs in the same ledger as
 * a code, so it's recorded as a redemption with no code row behind it.
 */
const applySchema = z
  .object({
    invoiceNumber: z.string().trim().min(1),
    /** Use an existing code… */
    code: z.string().trim().max(40).optional(),
    /** …or grant a one-off. */
    kind: z.enum(DISCOUNT_KINDS).optional(),
    value: z.number().positive().optional(),
    reason: z.string().trim().max(200).default(""),
    /** Customer details for the ledger, off the session card. */
    phone: z.string().trim().max(20).default(""),
    customerName: z.string().trim().max(80).default(""),
    /** Who's granting it — the roster picker, same as the expense form. */
    employeeId: z.string().trim().max(60).optional(),
    employeeName: z.string().trim().min(1, "Pick who's applying this").max(60),
  })
  .refine((v) => Boolean(v.code) !== (v.kind != null && v.value != null), {
    message: "Either pick a code or enter a one-off amount",
    path: ["code"],
  })
  .refine((v) => v.kind !== "percent" || (v.value ?? 0) <= 100, {
    message: "A percentage can't be over 100",
    path: ["value"],
  });

/** Counter-facing copy for a provider refusal. */
const REFUSAL_COPY: Record<DiscountRefusalReason, string> = {
  paid: "This invoice is already paid — discount it before collecting.",
  "part-paid": "Part of this invoice is already collected, so it can't be re-priced.",
  "not-found": "Couldn't find that invoice.",
  "too-large": "That's more than the invoice total.",
  unsupported: "This invoice has items the app can't re-price — discount it in Swipe.",
};

export async function POST(req: Request) {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!dbConfigured()) {
    return NextResponse.json(
      { error: "Discounts need the database — set DATABASE_URL" },
      { status: 503 }
    );
  }

  let input: z.infer<typeof applySchema>;
  try {
    input = applySchema.parse(await req.json());
  } catch (err) {
    const message = err instanceof z.ZodError ? err.issues[0]?.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  // The invoice total is the gross a percentage applies to, and the ceiling a
  // flat amount can't exceed. Read it from the billing backend rather than
  // taking the board's word for it.
  let booking;
  try {
    booking = await billing.getBookingByInvoiceNumber(input.invoiceNumber);
  } catch (err) {
    console.error("discount lookup failed:", err);
    return NextResponse.json({ error: "Couldn't read that invoice" }, { status: 502 });
  }
  if (!booking) {
    return NextResponse.json({ error: `No invoice ${input.invoiceNumber} found` }, { status: 404 });
  }
  if (booking.paid) {
    return NextResponse.json({ error: REFUSAL_COPY.paid }, { status: 409 });
  }

  const gross = booking.amount;

  // Work out what's coming off, and reserve the use before touching Swipe — the
  // same order as self-checkout, and for the same reason: a discount that
  // reached the invoice but not the ledger is the one outcome worth avoiding.
  let codeId: string | null = null;
  let label = "MANUAL";
  let amount: number;
  try {
    if (input.code) {
      const evaluated = await evaluateCode({
        code: input.code,
        phone: input.phone,
        gross,
        channel: "counter",
      });
      codeId = evaluated.code.id;
      label = evaluated.code.code;
      amount = evaluated.amount;
    } else {
      // A one-off grant is priced the same way a code would be, so the two
      // kinds of discount can't drift apart on rounding or on the cap at gross.
      amount = discountAmountFor({ kind: input.kind!, value: input.value! }, gross);
    }
  } catch (err) {
    if (err instanceof DiscountError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error("discount evaluation failed:", err);
    return NextResponse.json({ error: "Couldn't apply that discount" }, { status: 502 });
  }

  if (!(amount > 0)) {
    return NextResponse.json({ error: "That works out to ₹0 off" }, { status: 400 });
  }

  const redemption = await redeem({
    codeId,
    code: label,
    phone: input.phone,
    customerName: input.customerName || booking.customerName,
    gross,
    discount: amount,
    net: Math.round((gross - amount) * 100) / 100,
    channel: "counter",
    appliedByEmployeeId: input.employeeId ?? null,
    appliedByName: input.employeeName,
    reason: input.reason,
  }).catch((err) => {
    if (err instanceof DiscountError) return err;
    throw err;
  });
  if (redemption instanceof DiscountError) {
    return NextResponse.json({ error: redemption.message }, { status: 409 });
  }

  try {
    const result = await billing.applyInvoiceDiscount({
      invoiceNumber: booking.invoiceNumber,
      amount,
      label,
      byName: input.employeeName,
      reason: input.reason,
    });

    if (!result.applied) {
      await releaseRedemption(redemption.id);
      const reason = result.refused ?? "not-found";
      return NextResponse.json({ error: REFUSAL_COPY[reason], refused: reason }, { status: 409 });
    }

    // Swipe's arithmetic wins — record what actually came off.
    const invoiceNumber = result.invoiceNumber ?? booking.invoiceNumber;
    const invoiceId = await findInvoiceIdByNumber(invoiceNumber).catch(() => null);
    const totals = {
      gross: result.gross ?? gross,
      discount: result.discount ?? amount,
      net: result.net ?? gross - amount,
    };
    await finalizeRedemption(redemption.id, { invoiceId, invoiceNumber, ...totals });

    // Re-price the invoice mirror too (nothing to do for un-mirrored invoices).
    if (invoiceId) {
      await applyDiscountMirror(invoiceId, {
        grossInr: totals.gross,
        discountInr: totals.discount,
        netInr: totals.net,
      }).catch((err) => console.error("discount mirror update failed:", err));
    }

    return NextResponse.json({
      ok: true,
      invoiceNumber: result.invoiceNumber,
      code: label,
      gross: result.gross,
      discount: result.discount,
      net: result.net,
    });
  } catch (err) {
    // The invoice wasn't re-priced, so the use goes back.
    await releaseRedemption(redemption.id).catch(() => {});
    console.error("counter discount failed:", err);
    return NextResponse.json(
      { error: "Couldn't apply the discount to the invoice — nothing was changed." },
      { status: 502 }
    );
  }
}
