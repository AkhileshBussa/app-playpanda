import { NextResponse } from "next/server";
import { z } from "zod";
import { computeQuote, PACKAGES, type PackageId } from "@/lib/pricing";
import { dbConfigured } from "@/lib/pg";
import { evaluateCode } from "@/lib/discounts/db";
import { DiscountError } from "@/lib/discounts/types";
import { CUSTOMER_CODES_ENABLED } from "@/lib/discounts/enabled";

export const dynamic = "force-dynamic";

/**
 * Price a code against a booking, for the form's live display.
 *
 * The gross is recomputed from the SELECTION here rather than taken from the
 * client: this endpoint is public, and a caller who could name their own gross
 * could name their own discount. Nothing is redeemed — /api/checkout re-checks
 * and spends the code under a lock when the booking is actually made.
 */
const checkSchema = z.object({
  code: z.string().trim().min(1).max(40),
  phone: z.string().regex(/^[6-9]\d{9}$/, "Please enter a valid 10-digit mobile number"),
  packageId: z.enum(PACKAGES.map((p) => p.id) as [PackageId, ...PackageId[]]),
  kids: z.number().int().min(1).max(15),
  extraAdults: z.number().int().min(0).max(20),
  childSocks: z.number().int().min(0).max(30),
  adultSocks: z.number().int().min(0).max(30),
});

export async function POST(req: Request) {
  let input: z.infer<typeof checkSchema>;
  try {
    input = checkSchema.parse(await req.json());
  } catch (err) {
    const message = err instanceof z.ZodError ? err.issues[0]?.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  // Codes switched off for customers, or no database ⇒ no codes exist. Both are
  // ordinary refusals rather than errors, so the form says "not valid" instead
  // of looking broken. (The counter's own path doesn't come through here.)
  if (!CUSTOMER_CODES_ENABLED || !dbConfigured()) {
    return NextResponse.json({ ok: false, error: "That code isn't valid" });
  }

  const quote = computeQuote(input);

  try {
    const { code, amount } = await evaluateCode({
      code: input.code,
      phone: input.phone,
      gross: quote.total,
      channel: "online",
    });
    return NextResponse.json({
      ok: true,
      code: code.code,
      amount,
      gross: quote.total,
      total: Math.round((quote.total - amount) * 100) / 100,
    });
  } catch (err) {
    if (err instanceof DiscountError) {
      // 200 with ok:false — a wrong code is a normal answer, not a failure.
      return NextResponse.json({ ok: false, error: err.message });
    }
    console.error("discount check failed:", err);
    return NextResponse.json({ error: "Couldn't check that code" }, { status: 502 });
  }
}
