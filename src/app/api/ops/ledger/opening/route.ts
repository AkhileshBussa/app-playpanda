import { NextResponse } from "next/server";
import { z } from "zod";
import { isAdminAuthed } from "@/lib/ops/auth";
import { isDay, isMonth, monthEnd, monthStart } from "@/lib/ledger/dates";
import { setOpening } from "@/lib/ledger/db";

export const dynamic = "force-dynamic";

const openingSchema = z.object({
  month: z.string().refine(isMonth, "Pick a month"),
  openingInr: z.number().min(0, "Opening balance can't be negative").max(10_000_000),
  /**
   * The first day the ledger covers, for a month it was switched on part-way
   * through — September 2026 starts on the 6th, because that's when the drawer
   * was first counted. Omit for a full month.
   */
  startsOn: z.string().refine(isDay).optional(),
  setBy: z.string().trim().max(60).default(""),
});

/**
 * Set a month's opening balance — the owner's job, so admin-only.
 *
 * Setting it makes the opening explicit, which pins it: from then on it is
 * never overwritten by the carry-forward from the previous month's close.
 */
export async function PUT(req: Request) {
  if (!(await isAdminAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let input: z.infer<typeof openingSchema>;
  try {
    input = openingSchema.parse(await req.json());
  } catch (err) {
    const message = err instanceof z.ZodError ? err.issues[0]?.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  if (
    input.startsOn &&
    (input.startsOn < monthStart(input.month) || input.startsOn > monthEnd(input.month))
  ) {
    return NextResponse.json({ error: "That day isn't in this month" }, { status: 400 });
  }

  try {
    // This route is admin-only, so the tier is settled before we get here.
    const month = await setOpening({
      ...input,
      isExplicit: true,
      actor: { name: input.setBy, tier: "owner" },
    });
    return NextResponse.json({ month });
  } catch (err) {
    console.error("ledger opening failed:", err);
    return NextResponse.json({ error: "Couldn't save the opening balance" }, { status: 500 });
  }
}
