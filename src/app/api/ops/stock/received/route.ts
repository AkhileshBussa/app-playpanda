import { NextResponse } from "next/server";
import { z } from "zod";
import { isAdminAuthed } from "@/lib/ops/auth";
import { listVendors, recordStockReceived } from "@/lib/inventory/purchases";

export const dynamic = "force-dynamic";

/**
 * Recording stock received — owner only, like the rest of the catalogue.
 *
 * It raises a real purchase invoice against a vendor: it moves stock, moves
 * money, and lands in the books. That's a step beyond "what's running out",
 * which is the part of this page the counter needs. Easy to relax later if
 * deliveries turn out to arrive when only the counter is there.
 */
const receivedSchema = z.object({
  vendorId: z.number().int().positive("Pick a vendor"),
  lines: z
    .array(
      z.object({
        productId: z.number().int().positive(),
        name: z.string().trim().min(1).max(120),
        qty: z.number().positive("Quantity must be more than zero").max(100_000),
        unitCostWithTax: z.number().min(0).max(1_000_000),
        taxRatePercent: z.number().min(0).max(28),
      })
    )
    .min(1, "Add at least one product")
    .max(50),
  paymentMode: z.enum(["Cash", "UPI", "Card", "Net Banking", "Cheque"]),
  paid: z.boolean().default(true),
});

/** Vendors we've bought from before, for the form's picker. */
export async function GET() {
  if (!(await isAdminAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({ vendors: await listVendors() });
  } catch (err) {
    console.error("vendor list failed:", err);
    return NextResponse.json({ error: "Couldn't read vendors from Swipe" }, { status: 502 });
  }
}

export async function POST(req: Request) {
  if (!(await isAdminAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let input: z.infer<typeof receivedSchema>;
  try {
    input = receivedSchema.parse(await req.json());
  } catch (err) {
    const message = err instanceof z.ZodError ? err.issues[0]?.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    const result = await recordStockReceived(input);
    return NextResponse.json(result);
  } catch (err) {
    console.error("stock received failed:", err);
    const message = err instanceof Error ? err.message : "Swipe rejected the purchase";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
