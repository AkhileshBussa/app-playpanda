import { NextResponse } from "next/server";
import { z } from "zod";
import { isAdminAuthed, isOpsAuthed } from "@/lib/ops/auth";
import { listPurchases, recordStockReceived } from "@/lib/inventory/purchases";
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
  raisedBy: z.string().trim().max(60).default(""),
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
