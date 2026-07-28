import { NextResponse } from "next/server";
import { z } from "zod";
import { computeQuote, PACKAGES, type PackageId } from "@/lib/pricing";
import { billing } from "@/lib/billing";

const bookingSchema = z.object({
  name: z.string().trim().min(2, "Please enter your name").max(60),
  phone: z.string().regex(/^[6-9]\d{9}$/, "Please enter a valid 10-digit mobile number"),
  packageId: z.enum(PACKAGES.map((p) => p.id) as [PackageId, ...PackageId[]]),
  kids: z.number().int().min(1).max(15),
  extraAdults: z.number().int().min(0).max(20),
  childSocks: z.number().int().min(0).max(30),
  adultSocks: z.number().int().min(0).max(30),
  kidNames: z.array(z.string().trim().max(40)).max(15).optional(),
});

export async function POST(req: Request) {
  let input: z.infer<typeof bookingSchema>;
  try {
    input = bookingSchema.parse(await req.json());
  } catch (err) {
    const message = err instanceof z.ZodError ? err.issues[0]?.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  // Price is always computed server-side; the client total is display-only.
  const quote = computeQuote(input);
  const kidNames = (input.kidNames ?? []).map((n) => n.trim()).filter(Boolean);

  // 4-digit code the customer shows and the counter matches against the invoice.
  const validationCode = String(Math.floor(1000 + Math.random() * 9000));
  const paymentsEnabled = process.env.NEXT_PUBLIC_PAYMENTS_ENABLED !== "false";

  try {
    const booking = await billing.createBooking({
      customer: { name: input.name, phone: input.phone, kidNames },
      lines: quote.lines,
      validationCode,
    });

    // The invoice now exists in the billing backend (unpaid). While online
    // payment is off, the customer pays at the counter. `ref` is an opaque
    // handle for recording the payment later.
    return NextResponse.json({
      skipPayment: !paymentsEnabled,
      invoiceNumber: booking.invoiceNumber,
      ref: booking.ref,
      validationCode,
      total: quote.total,
    });
  } catch (err) {
    console.error("checkout failed:", err);
    return NextResponse.json(
      { error: "We couldn't create your booking. Please try again or ask at the counter." },
      { status: 502 }
    );
  }
}
