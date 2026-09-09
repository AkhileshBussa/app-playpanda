import { NextResponse } from "next/server";
import { z } from "zod";
import { isOpsAuthed } from "@/lib/ops/auth";
import { todayIST } from "@/lib/ops/state";
import { PAYMENT_METHODS } from "@/lib/billing/types";
import { getMembership, membersDbConfigured, updateMembership } from "@/lib/members/db";
import { getPlan, getPunchProduct, MEMBERSHIP_PLANS } from "@/lib/members/plans";
import { mirrorEdit } from "@/lib/members/sheets";
import { updatePaymentMethod } from "@/lib/invoices/db";

export const dynamic = "force-dynamic";

const fixedKeys = MEMBERSHIP_PLANS.map((p) => p.key) as [string, ...string[]];

const editSchema = z.object({
  membershipId: z.string().min(1),
  customerName: z.string().trim().min(1, "Customer name is required").max(80),
  kidNames: z.string().trim().max(200).default(""),
  planKey: z.enum([...fixedKeys, "custom"]),
  /** Only read for a custom plan; fixed plans take their name from the catalog. */
  planName: z.string().trim().max(60).default(""),
  punchProductId: z.number().int(),
  totalPlays: z.number().int().min(1).max(500).nullable(),
  hoursPerPlay: z.number().min(0.5).max(12),
  kidsPerPlay: z.number().int().min(1).max(10),
  weekdaysOnly: z.boolean(),
  oncePerDay: z.boolean(),
  startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid start date"),
  expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid expiry date"),
  createdOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid created date"),
  notes: z.string().trim().max(500).default(""),
  paidBy: z.enum(PAYMENT_METHODS).optional(),
  paidByRef: z.string().trim().max(60).default(""),
});

/**
 * Correct a membership after the fact: names, which plan it is, its terms,
 * its dates, and how the sale was paid in our ledger.
 *
 * What this route will NOT touch is money in the billing system. The sale
 * invoice, its price and its payment stand exactly as billed — an edit here
 * can widen a plan or fix a name, never make the ledger disagree with Swipe
 * about what was charged. Correcting paid_by rewrites our mirror only, and
 * says so in the response.
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

  const punch = getPunchProduct(input.punchProductId);
  if (!punch) {
    return NextResponse.json({ error: "Pick which Swipe punch product this plan maps to" }, { status: 400 });
  }
  const fixed = input.planKey === "custom" ? null : getPlan(input.planKey);
  if (input.planKey !== "custom" && !fixed) {
    return NextResponse.json({ error: "Unknown plan" }, { status: 400 });
  }
  const planName = fixed ? fixed.name : input.planName;
  if (!planName) {
    return NextResponse.json({ error: "Custom plan needs a name" }, { status: 400 });
  }

  if (input.expiresOn < input.startsOn) {
    return NextResponse.json({ error: "Expiry can't be before the start date" }, { status: 400 });
  }
  if (input.createdOn > todayIST()) {
    return NextResponse.json({ error: "Created date can't be in the future" }, { status: 400 });
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
    // Plays already punched are real visits; the allowance can't drop below them.
    if (input.totalPlays != null && input.totalPlays < before.playsUsed) {
      return NextResponse.json(
        {
          error: `${before.playsUsed} play${before.playsUsed === 1 ? " has" : "s have"} already been punched — the total can't be lower than that.`,
        },
        { status: 400 }
      );
    }

    const membership = await updateMembership({
      id: input.membershipId,
      customerName: input.customerName,
      kidNames: input.kidNames,
      planKey: input.planKey,
      planName,
      punchProductId: punch.id,
      punchProductName: punch.name,
      punchTaxRatePercent: punch.taxRatePercent,
      totalPlays: input.totalPlays,
      hoursPerPlay: input.hoursPerPlay,
      kidsPerPlay: input.kidsPerPlay,
      weekdaysOnly: input.weekdaysOnly,
      oncePerDay: input.oncePerDay,
      startsOn: input.startsOn,
      expiresOn: input.expiresOn,
      createdOn: input.createdOn,
      notes: input.notes,
    });
    if (!membership) {
      return NextResponse.json({ error: "Membership not found" }, { status: 404 });
    }

    let paymentWarning: string | null = null;
    const methodChanged =
      input.paidBy != null &&
      (input.paidBy !== before.paidBy || input.paidByRef !== before.paidByRef);
    if (methodChanged) {
      if (!before.salePaymentId) {
        paymentWarning =
          before.salePaymentCount > 1
            ? "More than one payment is recorded against this sale, so how it was paid was left alone — fix it on the invoice."
            : "No payment of ours is recorded against this sale, so how it was paid was left alone.";
      } else {
        const done = await updatePaymentMethod({
          paymentId: before.salePaymentId,
          method: input.paidBy!,
          transactionRef: input.paidByRef,
        });
        paymentWarning = done
          ? `Paid by is now ${input.paidBy} in our ledger. Swipe still shows ${before.paidBy || "what it recorded"} — change it there too if it matters.`
          : "How it was paid couldn't be updated — please try again.";
      }
    }

    await mirrorEdit({ before, after: membership });

    return NextResponse.json({ membership, warning: paymentWarning });
  } catch (err) {
    console.error("membership edit failed:", err);
    return NextResponse.json({ error: "Couldn't save the changes — please try again" }, { status: 502 });
  }
}
