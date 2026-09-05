import { NextResponse } from "next/server";
import { z } from "zod";
import { isAdminAuthed, isOpsAuthed } from "@/lib/ops/auth";
import { isDay, istToday } from "@/lib/ledger/dates";
import { addMovement, deleteMovement } from "@/lib/ledger/db";

export const dynamic = "force-dynamic";

const movementSchema = z.object({
  day: z.string().refine(isDay, "Pick a day"),
  amountInr: z.number().positive("Amount must be more than ₹0").max(10_000_000),
  /** Who took it. */
  party: z.string().trim().max(60).default(""),
  recordedBy: z.string().trim().max(60).default(""),
});

/**
 * Log cash leaving the store outside of sales and expenses.
 *
 * Only ever outward. The store takes cash in over the counter and pays it out
 * as expenses; nobody puts cash back into the drawer, so offering the choice
 * would only be a way to mistype one. The stored row still carries a direction
 * (and the balance still adds an inward one correctly, should one ever exist)
 * — there is simply no way to create one from here.
 */
export async function POST(req: Request) {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let input: z.infer<typeof movementSchema>;
  try {
    input = movementSchema.parse(await req.json());
  } catch (err) {
    const message = err instanceof z.ZodError ? err.issues[0]?.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  if (input.day > istToday()) {
    return NextResponse.json({ error: "That day hasn't happened yet" }, { status: 400 });
  }

  try {
    const actor = {
      name: input.recordedBy,
      tier: ((await isAdminAuthed()) ? "owner" : "counter") as "owner" | "counter",
    };
    return NextResponse.json({
      movement: await addMovement({ ...input, direction: "out", actor }),
    });
  } catch (err) {
    console.error("ledger movement failed:", err);
    return NextResponse.json({ error: "Couldn't save that" }, { status: 500 });
  }
}

/**
 * Remove a mistyped entry. Owner only.
 *
 * Logging a withdrawal is a record of money that left; making one disappear is
 * a different act entirely, and not one the person who logged it should be
 * able to perform on their own. The history survives either way — the removal
 * itself is recorded — but the decision belongs to the owner.
 */
export async function DELETE(req: Request) {
  if (!(await isAdminAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  try {
    // Nothing on the board asks who's removing it, so the history keeps the
    // verified tier and an empty name rather than inventing one.
    const removed = await deleteMovement(id, {
      name: "",
      tier: (await isAdminAuthed()) ? "owner" : "counter",
    });
    if (!removed) return NextResponse.json({ error: "Already gone" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("ledger movement delete failed:", err);
    return NextResponse.json({ error: "Couldn't remove that" }, { status: 500 });
  }
}
