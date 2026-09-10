import { NextResponse } from "next/server";
import { z } from "zod";
import { isOpsAuthed } from "@/lib/ops/auth";
import { bumpBoard, todayIST } from "@/lib/ops/state";
import { billing } from "@/lib/billing";
import { PAYMENT_METHODS } from "@/lib/billing/types";
import { createMembership, listMembershipsByPhone, membersDbConfigured } from "@/lib/members/db";
import {
  addMonths,
  getPlan,
  getPunchProduct,
  getSaleProductFor,
  MEMBERSHIP_PLANS,
} from "@/lib/members/plans";
import { membershipStatus, normalizePhone } from "@/lib/members/types";
import { mirrorMembership } from "@/lib/members/sheets";
import { recordInvoice, recordPaymentMirror } from "@/lib/invoices/db";
import { dbConfigured } from "@/lib/pg";

export const dynamic = "force-dynamic";

const fixedKeys = MEMBERSHIP_PLANS.map((p) => p.key) as [string, ...string[]];

const customSchema = z.object({
  name: z.string().trim().min(1, "Custom plan needs a name").max(60),
  /** Which existing Swipe punch product the visits bill against. */
  punchProductId: z.number().int(),
  /** null = unlimited plays during validity. */
  totalPlays: z.number().int().min(1).max(500).nullable(),
  hoursPerPlay: z.number().min(0.5).max(12),
  kidsPerPlay: z.number().int().min(1).max(10).default(1),
  validityMonths: z.number().int().min(1).max(36),
  priceInr: z.number().min(0).nullable().default(null),
  weekdaysOnly: z.boolean().default(false),
  oncePerDay: z.boolean().default(false),
});

const createSchema = z.object({
  phone: z.string().transform(normalizePhone).refine((p) => /^\d{10}$/.test(p), "Enter a 10-digit phone number"),
  customerName: z.string().trim().min(1, "Customer name is required").max(80),
  kidNames: z.string().trim().max(200).default(""),
  planKey: z.enum([...fixedKeys, "custom"]),
  custom: customSchema.optional(),
  saleMode: z.enum(["bill", "link"]).default("bill"),
  priceInr: z.number().min(0).max(500000).nullable().default(null),
  paymentMethod: z.enum(PAYMENT_METHODS, { message: "Pick how it was paid" }),
  transactionRef: z.string().trim().max(60).default(""),
  saleInvoiceNumber: z.string().trim().max(30).default(""),
  startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid start date").optional(),
  createdOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid created date").optional(),
  notes: z.string().trim().max(500).default(""),
  /** Set after the duplicate warning to create anyway. */
  force: z.boolean().optional(),
});

/** Sell a membership: bill it in Swipe, take the payment, and record it here. */
export async function POST(req: Request) {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!membersDbConfigured()) {
    return NextResponse.json(
      { error: "Membership database not set up yet — set DATABASE_URL (see docs/memberships.md)" },
      { status: 503 }
    );
  }

  let input: z.infer<typeof createSchema>;
  try {
    input = createSchema.parse(await req.json());
  } catch (err) {
    const message = err instanceof z.ZodError ? err.issues[0]?.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  // Resolve the plan: fixed plans come from the catalog; custom plans carry
  // their own numbers but must map to an existing Swipe punch product.
  let plan;
  if (input.planKey === "custom") {
    if (!input.custom) {
      return NextResponse.json({ error: "Custom plan details are required" }, { status: 400 });
    }
    const punch = getPunchProduct(input.custom.punchProductId);
    if (!punch) {
      return NextResponse.json({ error: "Pick which Swipe punch product this plan maps to" }, { status: 400 });
    }
    plan = {
      planKey: "custom",
      planName: input.custom.name,
      punchProductId: punch.id,
      punchProductName: punch.name,
      totalPlays: input.custom.totalPlays,
      hoursPerPlay: input.custom.hoursPerPlay,
      kidsPerPlay: input.custom.kidsPerPlay,
      priceInr: input.custom.priceInr,
      weekdaysOnly: input.custom.weekdaysOnly,
      oncePerDay: input.custom.oncePerDay,
      validityMonths: input.custom.validityMonths,
    };
  } else {
    const fixed = getPlan(input.planKey);
    if (!fixed) return NextResponse.json({ error: "Unknown plan" }, { status: 400 });
    plan = {
      planKey: fixed.key,
      planName: fixed.name,
      punchProductId: fixed.punchProductId,
      punchProductName: fixed.punchProductName,
      totalPlays: fixed.totalPlays,
      hoursPerPlay: fixed.hoursPerPlay,
      kidsPerPlay: fixed.kidsPerPlay,
      priceInr: fixed.priceWithTax,
      weekdaysOnly: fixed.weekdaysOnly,
      oncePerDay: fixed.oncePerDay,
      validityMonths: fixed.validityMonths,
    };
  }

  const billsHere = input.saleMode === "bill";
  const chargeInr = billsHere ? (input.priceInr ?? plan.priceInr ?? 0) : plan.priceInr;
  const saleProduct = getSaleProductFor({
    planKey: plan.planKey,
    punchProductId: plan.punchProductId,
  });
  if (billsHere && !saleProduct) {
    return NextResponse.json(
      { error: "This plan has no Swipe sale product to bill against" },
      { status: 400 }
    );
  }

  if (input.createdOn && input.createdOn > todayIST()) {
    return NextResponse.json({ error: "Created date can't be in the future" }, { status: 400 });
  }

  // A membership starts the day it's recorded; startsOn stays accepted for a
  // caller that means something different by it.
  const startsOn = input.startsOn ?? input.createdOn ?? todayIST();
  const expiresOn = addMonths(startsOn, plan.validityMonths);
  const kidNames = input.kidNames
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  try {
    // Advisory duplicate check (same pattern as the school log): warn when this
    // phone already holds an ACTIVE membership; the counter confirms to proceed.
    if (!input.force) {
      const existing = await listMembershipsByPhone(input.phone);
      const today = todayIST();
      const active = existing.filter((m) => membershipStatus(m, today) === "active");
      const dup = active.find((m) => m.planName === plan.planName) ?? active[0];
      if (dup) {
        return NextResponse.json(
          {
            duplicate: true,
            existing: dup,
            activeCount: active.length,
            samePlan: dup.planName === plan.planName,
          },
          { status: 409 }
        );
      }
    }

    let saleInvoiceNumber = input.saleInvoiceNumber;
    let saleInvoiceId: string | null = null;
    let paymentWarning: string | null = null;

    if (billsHere) {
      const terms = [
        plan.totalPlays == null ? "Unlimited plays" : `${plan.totalPlays} plays`,
        `${plan.hoursPerPlay} hrs per play`,
        `valid till ${expiresOn}`,
      ].join(" · ");

      let sale;
      try {
        sale = await billing.createMembershipSale({
          customer: { name: input.customerName, phone: input.phone, kidNames },
          plan: {
            sku: String(saleProduct!.id),
            name: plan.planName,
            taxRatePercent: saleProduct!.taxRatePercent,
            priceWithTax: chargeInr ?? 0,
            totalPlays: plan.totalPlays,
            hoursPerPlay: plan.hoursPerPlay,
            validityMonths: plan.validityMonths,
          },
          notes: [`${plan.planName} — ${terms}`, kidNames.length ? `Kids: ${kidNames.join(", ")}` : ""]
            .filter(Boolean)
            .join(" · "),
        });
      } catch (err) {
        console.error("membership sale invoice failed:", err);
        return NextResponse.json(
          { error: "Couldn't bill the membership in Swipe — nothing was saved. Please try again." },
          { status: 502 }
        );
      }
      saleInvoiceNumber = sale.invoiceNumber;

      if ((chargeInr ?? 0) > 0) {
        try {
          await billing.recordPayment({
            ref: sale.ref,
            amount: chargeInr!,
            method: input.paymentMethod,
            transactionRef: input.transactionRef || undefined,
          });
        } catch (err) {
          console.error("membership sale payment failed:", err);
          paymentWarning = `${saleInvoiceNumber} was billed but the ${input.paymentMethod} payment didn't record — collect it on the ops board.`;
        }
      }

      if (dbConfigured()) {
        const mirror = await recordInvoice({
          number: saleInvoiceNumber,
          source: "membership_sale",
          customer: {
            phone: input.phone,
            name: input.customerName,
            kidNames: input.kidNames,
            swipeRef: sale.customerRef ?? null,
          },
          swipeRef: sale.docRef ?? null,
          grossInr: chargeInr ?? 0,
          discountInr: 0,
          netInr: chargeInr ?? 0,
          lines: [
            {
              sku: String(saleProduct!.id),
              name: plan.planName,
              kind: "membership_plan",
              itemType: "Service",
              quantity: 1,
              unitPriceInr: chargeInr ?? 0,
              taxRatePercent: saleProduct!.taxRatePercent,
              totalInr: chargeInr ?? 0,
              listPriceInr: getPlan(plan.planKey)?.priceWithTax ?? null,
            },
          ],
          metadata: { plan_key: plan.planKey, plan_name: plan.planName },
        }).catch((err) => {
          console.error("membership sale mirror failed:", err);
          return null;
        });
        saleInvoiceId = mirror?.invoiceId ?? null;

        if (mirror && !paymentWarning && (chargeInr ?? 0) > 0) {
          await recordPaymentMirror({
            invoiceId: mirror.invoiceId,
            amountInr: chargeInr!,
            method: input.paymentMethod,
            transactionRef: input.transactionRef || undefined,
            amountDueAfter: 0,
          }).catch((err) => console.error("membership sale payment mirror failed:", err));
        }
      }
    }

    let membership;
    try {
      membership = await createMembership({
        phone: input.phone,
        customerName: input.customerName,
        kidNames: input.kidNames,
        ...plan,
        priceInr: chargeInr,
        punchTaxRatePercent: getPunchProduct(plan.punchProductId)?.taxRatePercent ?? 18,
        saleInvoiceNumber,
        saleInvoiceId,
        paidBy: input.paymentMethod,
        paidByRef: input.transactionRef,
        startsOn,
        expiresOn,
        createdOn: input.createdOn ?? null,
        notes: input.notes,
      });
    } catch (err) {
      console.error("membership create failed:", err);
      return NextResponse.json(
        {
          error: billsHere
            ? `${saleInvoiceNumber} was billed in Swipe, but saving the membership failed. Record it with "Already billed in Swipe" and that number.`
            : "Couldn't save the membership — please try again",
          saleInvoiceNumber: billsHere ? saleInvoiceNumber : undefined,
        },
        { status: 502 }
      );
    }

    await mirrorMembership(membership); // best-effort, never throws
    if (billsHere) await bumpBoard();

    return NextResponse.json({ membership, saleInvoiceNumber, warning: paymentWarning });
  } catch (err) {
    console.error("membership create failed:", err);
    return NextResponse.json({ error: "Couldn't save the membership — please try again" }, { status: 502 });
  }
}
