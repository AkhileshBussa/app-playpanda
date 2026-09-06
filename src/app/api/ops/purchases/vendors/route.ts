import { NextResponse } from "next/server";
import { z } from "zod";
import { isOpsAuthed } from "@/lib/ops/auth";
import { createVendor, listVendors } from "@/lib/inventory/purchases";

export const dynamic = "force-dynamic";

/** Suppliers already bought from — derived from a year of purchase invoices. */
export async function GET() {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({ vendors: await listVendors() });
  } catch (err) {
    console.error("vendor list failed:", err);
    return NextResponse.json({ error: "Couldn't read vendors from Swipe" }, { status: 502 });
  }
}

const vendorSchema = z.object({
  name: z.string().trim().min(1, "Name the supplier").max(100),
  /** Optional: Swipe takes a vendor with no phone. */
  phone: z.string().trim().regex(/^\d{10}$/, "Enter a 10-digit number").optional().or(z.literal("")),
});

/**
 * Add a supplier.
 *
 * Without this, the first purchase from anyone new was the one you couldn't
 * record here — you'd have to go and create them in Swipe first, which rather
 * defeats the point of raising purchases from the app at all.
 */
export async function POST(req: Request) {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let input: z.infer<typeof vendorSchema>;
  try {
    input = vendorSchema.parse(await req.json());
  } catch (err) {
    const message = err instanceof z.ZodError ? err.issues[0]?.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    const vendor = await createVendor({ name: input.name, phone: input.phone || undefined });
    return NextResponse.json({ vendor: { id: vendor.id, name: input.name } });
  } catch (err) {
    console.error("vendor create failed:", err);
    const message = err instanceof Error ? err.message : "Swipe rejected the supplier";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
