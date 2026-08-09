import { NextResponse } from "next/server";
import { z } from "zod";
import { isOpsAuthed } from "@/lib/ops/auth";
import { setRemoval, clearRemoval } from "@/lib/ops/state";

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
 * Nothing is deleted: the invoice is untouched, and the removal is a day-scoped
 * marker that expires at midnight IST with the rest of the day's state. Put back
 * with DELETE.
 */
export async function POST(req: Request) {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const id = await parseId(req);
  if (!id) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  try {
    await setRemoval(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("remove failed:", err);
    return NextResponse.json({ error: "Could not remove booking" }, { status: 502 });
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
