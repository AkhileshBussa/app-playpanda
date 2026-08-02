import { NextResponse } from "next/server";
import { z } from "zod";
import { isOpsAuthed } from "@/lib/ops/auth";
import { getMembership, membersDbConfigured, softDeleteMembership } from "@/lib/members/db";
import { mirrorDeletion } from "@/lib/members/sheets";

export const dynamic = "force-dynamic";

const removeSchema = z.object({
  membershipId: z.string().min(1),
  reason: z.string().trim().min(1, "Please give a reason for deleting").max(300),
});

/**
 * Soft-delete a membership: the row stays and is shown as deleted, with the
 * reason recorded. Its punches stay too — no Swipe invoices are touched.
 */
export async function POST(req: Request) {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!membersDbConfigured()) {
    return NextResponse.json({ error: "Membership database not set up yet" }, { status: 503 });
  }

  let input: z.infer<typeof removeSchema>;
  try {
    input = removeSchema.parse(await req.json());
  } catch (err) {
    const message = err instanceof z.ZodError ? err.issues[0]?.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    const existing = await getMembership(input.membershipId);
    if (!existing) {
      return NextResponse.json({ error: "Membership not found" }, { status: 404 });
    }
    if (existing.deletedAt != null) {
      return NextResponse.json({ membership: existing }); // already deleted — idempotent
    }

    const membership = await softDeleteMembership(input.membershipId, input.reason);
    if (!membership) {
      return NextResponse.json({ error: "Membership not found" }, { status: 404 });
    }

    await mirrorDeletion({
      what: "Membership",
      membership,
      detail: `${membership.planName} · expires ${membership.expiresOn} · ${membership.playsUsed} play(s) used`,
      reason: input.reason,
      id: membership.id,
      at: membership.deletedAt ?? Date.now(),
    });

    return NextResponse.json({ membership });
  } catch (err) {
    console.error("membership delete failed:", err);
    return NextResponse.json({ error: "Couldn't delete — please try again" }, { status: 502 });
  }
}
