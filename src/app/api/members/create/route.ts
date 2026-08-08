import { NextResponse } from "next/server";
import { z } from "zod";
import { isOpsAuthed } from "@/lib/ops/auth";
import { todayIST } from "@/lib/ops/state";
import { createMembership, listMembershipsByPhone, membersDbConfigured } from "@/lib/members/db";
import { addMonths, getPlan, getPunchProduct, MEMBERSHIP_PLANS } from "@/lib/members/plans";
import { membershipStatus, normalizePhone } from "@/lib/members/types";
import { mirrorMembership } from "@/lib/members/sheets";

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
  saleInvoiceNumber: z.string().trim().max(30).default(""),
  startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid start date").optional(),
  notes: z.string().trim().max(500).default(""),
  /** Set after the duplicate warning to create anyway. */
  force: z.boolean().optional(),
});

/** Record a membership (the sale itself is billed manually in Swipe, as before). */
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

  const startsOn = input.startsOn ?? todayIST();
  const expiresOn = addMonths(startsOn, plan.validityMonths);

  try {
    // Advisory duplicate check (same pattern as the school log): warn when this
    // phone already has an ACTIVE membership on the same plan; force to proceed.
    if (!input.force) {
      const existing = await listMembershipsByPhone(input.phone);
      const today = todayIST();
      const dup = existing.find(
        (m) => m.planName === plan.planName && membershipStatus(m, today) === "active"
      );
      if (dup) {
        return NextResponse.json({ duplicate: true, existing: dup }, { status: 409 });
      }
    }

    const membership = await createMembership({
      phone: input.phone,
      customerName: input.customerName,
      kidNames: input.kidNames,
      ...plan,
      saleInvoiceNumber: input.saleInvoiceNumber,
      startsOn,
      expiresOn,
      notes: input.notes,
    });

    await mirrorMembership(membership); // best-effort, never throws

    return NextResponse.json({ membership });
  } catch (err) {
    console.error("membership create failed:", err);
    return NextResponse.json({ error: "Couldn't save the membership — please try again" }, { status: 502 });
  }
}
