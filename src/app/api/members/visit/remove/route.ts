import { NextResponse } from "next/server";
import { z } from "zod";
import { isOpsAuthed } from "@/lib/ops/auth";
import { membersDbConfigured, softDeleteVisit } from "@/lib/members/db";
import { mirrorDeletion } from "@/lib/members/sheets";

export const dynamic = "force-dynamic";

const removeSchema = z.object({
  visitId: z.string().min(1),
  reason: z.string().trim().min(1, "Please give a reason for deleting").max(300),
});

const istDateTime = (ms: number) =>
  new Date(ms).toLocaleString("en-IN", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
    hour12: true, timeZone: "Asia/Kolkata",
  });

/**
 * Soft-delete a punch. The row stays (shown as deleted, with the reason) and
 * its plays go back to the membership, since every plays-used sum ignores
 * deleted rows. The ₹0 punch invoice in Swipe is NOT touched — the response
 * carries its number so the UI can tell the manager to remove it there.
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
    const result = await softDeleteVisit(input.visitId, input.reason);
    if (!result) {
      return NextResponse.json({ error: "Punch not found, or already deleted" }, { status: 404 });
    }
    const { visit, membership } = result;

    await mirrorDeletion({
      what: "Punch",
      membership,
      detail:
        `${istDateTime(visit.visitedAt)} · ${visit.kidsCount} kid(s) · ${visit.playsUsed} play(s)` +
        (visit.punchInvoiceNumber ? ` · ${visit.punchInvoiceNumber}` : ""),
      reason: input.reason,
      id: visit.id,
      at: visit.deletedAt ?? Date.now(),
    });

    return NextResponse.json({ visit, membership });
  } catch (err) {
    console.error("punch delete failed:", err);
    return NextResponse.json({ error: "Couldn't delete — please try again" }, { status: 502 });
  }
}
