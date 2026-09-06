import { NextResponse } from "next/server";
import { z } from "zod";
import { isAdminAuthed, isOpsAuthed } from "@/lib/ops/auth";
import {
  deletePurchase,
  listPurchases,
  readPurchase,
  recordStockReceived,
} from "@/lib/inventory/purchases";
import { isMonth, istToday, monthEnd, monthLabel, monthStart } from "@/lib/ledger/dates";

export const dynamic = "force-dynamic";

/**
 * Stock buying — the purchases side of the books.
 *
 * Deliberately the same shape as /api/ops/expenses: read live from Swipe,
 * no local copy to drift. Purchases are not expenses (the money becomes stock
 * rather than being spent) which is why they get their own page rather than a
 * filter on that one.
 */
export async function GET(req: Request) {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ?ref= reads one purchase back in the shape the edit form wants.
  const ref = new URL(req.url).searchParams.get("ref")?.trim();
  if (ref) {
    try {
      const purchase = await readPurchase(ref);
      if (!purchase) return NextResponse.json({ error: "Not found" }, { status: 404 });
      return NextResponse.json({ purchase });
    } catch (err) {
      console.error("purchase read failed:", err);
      return NextResponse.json({ error: "Couldn't read that purchase" }, { status: 502 });
    }
  }

  const param = new URL(req.url).searchParams.get("month");
  const month = param && isMonth(param) ? param : istToday().slice(0, 7);

  try {
    const data = await listPurchases(monthStart(month), monthEnd(month));
    return NextResponse.json({ ...data, month, label: monthLabel(month) });
  } catch (err) {
    console.error("purchase list failed:", err);
    const message =
      err instanceof Error && err.message.includes("No Swipe token")
        ? "Swipe token missing or expired — refresh it from pp-billing → Settings"
        : "Couldn't load purchases from Swipe";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

/**
 * Raise one. The counter may, on the same reasoning that opened up the
 * catalogue: the person taking the delivery is the one who knows what arrived,
 * and every purchase carries who recorded it.
 */
const purchaseSchema = z.object({
  vendorId: z.number().int().positive("Pick a vendor"),
  lines: z
    .array(
      z.object({
        productId: z.number().int().positive(),
        name: z.string().trim().min(1).max(120),
        qty: z.number().positive("Quantity must be more than zero").max(100_000),
        unitCostWithTax: z.number().min(0).max(1_000_000),
        taxRatePercent: z.number().min(0).max(28),
        unit: z.string().trim().max(20).optional(),
      })
    )
    .min(1, "Add at least one product")
    .max(50),
  paymentMode: z.enum(["Cash", "UPI", "Card", "Net Banking", "Cheque"]),
  paid: z.boolean().default(true),
});

export async function POST(req: Request) {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let input: z.infer<typeof purchaseSchema>;
  try {
    input = purchaseSchema.parse(await req.json());
  } catch (err) {
    const message = err instanceof z.ZodError ? err.issues[0]?.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    const result = await recordStockReceived(input);
    return NextResponse.json({ ...result, byOwner: await isAdminAuthed() });
  } catch (err) {
    console.error("purchase create failed:", err);
    const message = err instanceof Error ? err.message : "Swipe rejected the purchase";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

/**
 * Rewrite a purchase in place — same document, same serial.
 *
 * The counter may, as with raising one: a delivery short by two bottles is
 * noticed at the counter, not in an office. Removing a purchase outright is a
 * different act and stays owner-only, exactly as with the cash ledger's
 * withdrawals.
 */
const editSchema = purchaseSchema.extend({
  ref: z.string().trim().min(1),
  docId: z.number().int().positive(),
  docNumber: z.number().int().positive(),
  serialNumber: z.string().trim().min(1),
});

export async function PATCH(req: Request) {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let input: z.infer<typeof editSchema>;
  try {
    input = editSchema.parse(await req.json());
  } catch (err) {
    const message = err instanceof z.ZodError ? err.issues[0]?.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    const result = await recordStockReceived({
      ...input,
      editDocId: input.docId,
      editDocNumber: input.docNumber,
      editSerialNumber: input.serialNumber,
    });
    return NextResponse.json(result);
  } catch (err) {
    console.error("purchase edit failed:", err);
    const message = err instanceof Error ? err.message : "Swipe rejected the change";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

/**
 * Delete a purchase. Owner only.
 *
 * It takes the stock back off the shelf and, if it was paid in cash, moves the
 * drawer's balance — correctly, since money that never left shouldn't be
 * counted as gone. That's a bigger consequence than mistyping a quantity, and
 * the same reasoning that keeps removing a logged withdrawal owner-only.
 */
export async function DELETE(req: Request) {
  if (!(await isAdminAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const ref = new URL(req.url).searchParams.get("ref")?.trim();
  if (!ref) return NextResponse.json({ error: "Missing ref" }, { status: 400 });

  try {
    await deletePurchase(ref, "Removed from Play Panda ops");
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("purchase delete failed:", err);
    const message = err instanceof Error ? err.message : "Swipe wouldn't remove it";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
