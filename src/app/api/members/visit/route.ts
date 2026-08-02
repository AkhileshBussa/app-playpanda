import { NextResponse } from "next/server";
import { z } from "zod";
import { isOpsAuthed } from "@/lib/ops/auth";
import { todayIST } from "@/lib/ops/state";
import { billing } from "@/lib/billing";
import {
  hardDeleteVisit,
  getMembership,
  membersDbConfigured,
  recordVisit,
  setVisitInvoice,
  VisitError,
} from "@/lib/members/db";
import { getPunchProduct } from "@/lib/members/plans";
import { isWeekday, playsForKids } from "@/lib/members/types";
import { mirrorVisit } from "@/lib/members/sheets";

export const dynamic = "force-dynamic";

const visitSchema = z.object({
  membershipId: z.string().min(1),
  kidsCount: z.number().int().min(1).max(10),
  kidNames: z.string().trim().max(200).default(""),
  /** Set after the weekday-only warning to punch anyway (manager's call). */
  force: z.boolean().optional(),
});

/**
 * Punch a membership visit: atomically consume plays in Postgres, then create
 * the ₹0 punch invoice in Swipe (so the visit shows on /ops and in billing).
 * If the Swipe invoice fails, the consumed plays are restored — the two systems
 * never drift by more than the in-flight request.
 */
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

  let input: z.infer<typeof visitSchema>;
  try {
    input = visitSchema.parse(await req.json());
  } catch (err) {
    const message = err instanceof z.ZodError ? err.issues[0]?.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const today = todayIST();

  try {
    const existing = await getMembership(input.membershipId);
    if (!existing) {
      return NextResponse.json({ error: "Membership not found" }, { status: 404 });
    }

    // Weekday-only passes: soft block — the manager can force (goodwill
    // exceptions happen); expiry and play counts below stay hard rules.
    if (existing.weekdaysOnly && !isWeekday(today) && !input.force) {
      return NextResponse.json(
        {
          code: "weekend",
          warning: true,
          error: `${existing.planName} is valid Monday–Friday only — tap Punch again to allow it anyway.`,
        },
        { status: 409 }
      );
    }

    const playsUsed = playsForKids(input.kidsCount, existing.kidsPerPlay);

    const { visit, membership } = await recordVisit({
      membershipId: input.membershipId,
      kidsCount: input.kidsCount,
      playsUsed,
      kidNames: input.kidNames,
      visitDate: today,
    });

    let invoiceNumber = "";
    try {
      const kidNames = (input.kidNames || membership.kidNames)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await billing.createMembershipPunch({
        customer: { name: membership.customerName, phone: membership.phone, kidNames },
        punch: {
          sku: String(membership.punchProductId),
          name: membership.punchProductName,
          taxRatePercent: getPunchProduct(membership.punchProductId)?.taxRatePercent ?? 18,
          quantity: playsUsed,
          hoursPerPlay: membership.hoursPerPlay,
          totalPlays: membership.totalPlays,
        },
        notes: `Membership visit — ${membership.planName}${kidNames.length ? ` · Kids: ${kidNames.join(", ")}` : ""}`,
      });
      invoiceNumber = res.invoiceNumber;
    } catch (err) {
      // Swipe failed → give the plays back so nothing is silently consumed.
      console.error("punch invoice failed, rolling back visit:", err);
      await hardDeleteVisit(visit.id).catch((rollbackErr) => {
        console.error("CRITICAL: visit rollback failed — plays over-deducted:", visit.id, rollbackErr);
      });
      return NextResponse.json(
        { error: "Couldn't create the punch invoice in Swipe — no plays were used. Please try again." },
        { status: 502 }
      );
    }

    await setVisitInvoice(visit.id, invoiceNumber).catch((err) => {
      // Non-fatal: the visit stands, only the invoice back-reference is missing.
      console.error("failed to stamp punch invoice on visit:", err);
    });
    visit.punchInvoiceNumber = invoiceNumber;

    await mirrorVisit(visit, membership); // best-effort, never throws

    return NextResponse.json({ visit, membership });
  } catch (err) {
    if (err instanceof VisitError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
    }
    console.error("membership visit failed:", err);
    return NextResponse.json({ error: "Couldn't record the visit — please try again" }, { status: 502 });
  }
}
