import { NextResponse } from "next/server";
import { z } from "zod";
import { billing } from "@/lib/billing";

const confirmSchema = z.object({
  ref: z.string().min(1),
  amount: z.number().positive(),
  method: z.string().min(1),
  transactionRef: z.string().optional(),
});

/**
 * Called by the browser after a payment is collected. Records it against the
 * booking (marks the invoice paid). Dormant while online payment is off
 * (NEXT_PUBLIC_PAYMENTS_ENABLED="false"); wired for when collection goes live.
 */
export async function POST(req: Request) {
  let input: z.infer<typeof confirmSchema>;
  try {
    input = confirmSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    await billing.recordPayment(input);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("payment record failed:", err);
    // The customer HAS paid at this point — never show a scary failure.
    return NextResponse.json(
      {
        error:
          "Payment received, but we couldn't update the invoice. Please show your payment confirmation at the counter.",
      },
      { status: 502 }
    );
  }
}
