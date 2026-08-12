import { NextResponse } from "next/server";
import { z } from "zod";
import { billing } from "@/lib/billing";
import { isOpsAuthed } from "@/lib/ops/auth";
import { setRemoval, clearRemoval } from "@/lib/ops/state";
import { dbConfigured } from "@/lib/pg";
import { releaseForInvoice } from "@/lib/discounts/db";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ id: z.string().min(1) });

async function parseId(req: Request): Promise<string | null> {
  try {
    return bodySchema.parse(await req.json()).id;
  } catch {
    return null;
  }
}

/**
 * Take a booking off today's board without checking it in — a no-show, or a
 * booking the customer cancelled at the door.
 *
 * Two steps, deliberately in this order and deliberately not atomic:
 *
 * 1. The board marker, which is day-scoped and reversible.
 * 2. Cancelling the invoice, but ONLY when nothing has been collected against
 *    it — the provider re-checks that itself and refuses otherwise.
 *
 * The marker goes first because it always succeeds and is what the manager is
 * actually waiting on. If the cancel then fails or is refused, the card is still
 * off the board and the response says what happened to the invoice, so the
 * counter can deal with it in Swipe. The reverse order would leave a cancelled
 * invoice behind a card still sitting on the board.
 *
 * DELETE puts the card back. It does NOT un-cancel the invoice — Swipe has no
 * such call, which is why the confirm on the card says so.
 */
export async function POST(req: Request) {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const id = await parseId(req);
  if (!id) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  try {
    await setRemoval(id);
  } catch (err) {
    console.error("remove failed:", err);
    return NextResponse.json({ error: "Could not remove booking" }, { status: 502 });
  }

  try {
    const result = await billing.cancelSessionInvoice({
      sessionId: id,
      remarks: "No-show — cleared from the session monitor",
    });
    // A cancelled booking gives its discount code back: the invoice it was
    // spent on no longer exists, so the family (or the next one) can use it.
    if (result.cancelled && result.invoiceNumber && dbConfigured()) {
      await releaseForInvoice(result.invoiceNumber).catch((err) =>
        console.error("failed to release discount after cancel:", err)
      );
    }
    return NextResponse.json({ ok: true, invoice: result });
  } catch (err) {
    // The booking is off the board either way; the invoice just needs a human.
    console.error("invoice cancel failed after removal:", err);
    return NextResponse.json({ ok: true, invoice: { cancelled: false, refused: "error" } });
  }
}

/** Put a removed booking back on the board. */
export async function DELETE(req: Request) {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const id = await parseId(req);
  if (!id) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  try {
    await clearRemoval(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("undo remove failed:", err);
    return NextResponse.json({ error: "Could not put the booking back" }, { status: 502 });
  }
}
