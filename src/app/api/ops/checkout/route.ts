import { NextResponse } from "next/server";
import { z } from "zod";
import { isOpsAuthed } from "@/lib/ops/auth";
import { setCheckout, clearCheckout } from "@/lib/ops/state";
import { stampInvoiceSession } from "@/lib/invoices/db";
import { dbConfigured } from "@/lib/pg";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ id: z.string().min(1) });

async function parseId(req: Request): Promise<string | null> {
  try {
    return bodySchema.parse(await req.json()).id;
  } catch {
    return null;
  }
}

/** Mark a session as left (checked out). */
export async function POST(req: Request) {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const id = await parseId(req);
  if (!id) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  try {
    const at = Date.now();
    await setCheckout(id, at);
    // Durable copy on the invoice mirror; Redis stays the day's fast path.
    if (dbConfigured()) {
      await stampInvoiceSession("checkout", id, at).catch((err) =>
        console.error("check-out stamp failed:", err)
      );
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("check-out failed:", err);
    return NextResponse.json({ error: "Check-out failed" }, { status: 502 });
  }
}

/** Undo a check-out. */
export async function DELETE(req: Request) {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const id = await parseId(req);
  if (!id) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  try {
    await clearCheckout(id);
    if (dbConfigured()) {
      await stampInvoiceSession("checkout", id, null).catch((err) =>
        console.error("check-out unstamp failed:", err)
      );
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("undo check-out failed:", err);
    return NextResponse.json({ error: "Could not undo check-out" }, { status: 502 });
  }
}
