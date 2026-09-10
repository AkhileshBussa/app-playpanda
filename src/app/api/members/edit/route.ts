import { NextResponse } from "next/server";
import { z } from "zod";
import { isOpsAuthed } from "@/lib/ops/auth";
import { todayIST } from "@/lib/ops/state";
import { PAYMENT_METHODS } from "@/lib/billing/types";
import { getMembership, membersDbConfigured, updateMembership } from "@/lib/members/db";
import { mirrorEdit } from "@/lib/members/sheets";
import { updatePaymentMethod } from "@/lib/invoices/db";

export const dynamic = "force-dynamic";

const editSchema = z.object({
  membershipId: z.string().min(1),
  customerName: z.string().trim().min(1, "Parent's name is required").max(80),
  kidNames: z.string().trim().max(200).default(""),
  /** The day it's recorded under; a membership starts the day it's recorded. */
  createdOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date"),
  notes: z.string().trim().max(500).default(""),
  paidBy: z.enum(PAYMENT_METHODS, { message: "Pick how it was paid" }),
  paidByRef: z.string().trim().max(60).default(""),
});

/**
 * Fix what was typed wrong on a membership: the names, the day it sits under,
 * how the sale was paid, the notes.
 *
 * The plan and its terms are NOT editable — changing what was sold after the
 * sale invoice exists would leave our record disagreeing with Swipe, so a
 * wrong plan is a delete and a fresh sale.
 *
 * paid_by lives on the membership, so it's always correctable — including for
 * a sale nothing was billed for here. When one of our payments is mirrored
 * against the sale, it's corrected to match; Swipe keeps what it recorded,
 * and the response says so.
 */
export async function PATCH(req: Request) {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!membersDbConfigured()) {
    return NextResponse.json({ error: "Membership database not set up yet" }, { status: 503 });
  }

  let input: z.infer<typeof editSchema>;
  try {
    input = editSchema.parse(await req.json());
  } catch (err) {
    const message = err instanceof z.ZodError ? err.issues[0]?.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  if (input.createdOn > todayIST()) {
    return NextResponse.json({ error: "That date can't be in the future" }, { status: 400 });
  }

  try {
    const before = await getMembership(input.membershipId);
    if (!before) {
      return NextResponse.json({ error: "Membership not found" }, { status: 404 });
    }
    if (before.deletedAt != null) {
      return NextResponse.json(
        { error: "This membership is deleted — it can't be edited" },
        { status: 409 }
      );
    }

    const membership = await updateMembership({
      id: input.membershipId,
      customerName: input.customerName,
      kidNames: input.kidNames,
      createdOn: input.createdOn,
      paidBy: input.paidBy,
      paidByRef: input.paidByRef,
      notes: input.notes,
    });
    if (!membership) {
      return NextResponse.json({ error: "Membership not found" }, { status: 404 });
    }

    // The membership's own paid_by is already written above. When the sale also
    // has exactly one mirrored payment, that row is corrected to match, so the
    // ledger doesn't hold two answers.
    let paymentWarning: string | null = null;
    const methodChanged =
      input.paidBy !== before.paidBy || input.paidByRef !== before.paidByRef;
    if (methodChanged && before.salePaymentId) {
      const done = await updatePaymentMethod({
        paymentId: before.salePaymentId,
        method: input.paidBy,
        transactionRef: input.paidByRef,
      });
      paymentWarning = done
        ? `Paid by is now ${input.paidBy} here and on ${before.saleInvoiceNumber || "the sale"}. Swipe still shows ${before.paidBy || "what it recorded"} — change it there too if it matters.`
        : `Paid by is now ${input.paidBy} on the membership, but the payment against ${before.saleInvoiceNumber || "the sale"} kept its old method.`;
    } else if (methodChanged && before.salePaymentCount > 1) {
      paymentWarning = `Paid by is now ${input.paidBy} on the membership. ${before.saleInvoiceNumber || "The sale"} has more than one payment against it, so those were left as they are.`;
    }

    await mirrorEdit({ before, after: membership });

    return NextResponse.json({ membership, warning: paymentWarning });
  } catch (err) {
    console.error("membership edit failed:", err);
    return NextResponse.json({ error: "Couldn't save the changes — please try again" }, { status: 502 });
  }
}
