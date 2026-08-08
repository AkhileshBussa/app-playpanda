import { NextResponse } from "next/server";
import { z } from "zod";
import { isOpsAuthed } from "@/lib/ops/auth";
import { billing } from "@/lib/billing";
import { PAYMENT_METHODS } from "@/lib/billing/types";

export const dynamic = "force-dynamic";

const paymentSchema = z.object({
  invoiceNumber: z.string().trim().min(1),
  amount: z.number().positive("Enter an amount to collect"),
  method: z.enum(PAYMENT_METHODS),
  transactionRef: z.string().trim().max(60).optional(),
});

/**
 * Record a payment collected at the counter against a session's invoice.
 * Staff-only. All the billing specifics live behind `billing.collectPayment`.
 */
export async function POST(req: Request) {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let input: z.infer<typeof paymentSchema>;
  try {
    input = paymentSchema.parse(await req.json());
  } catch (err) {
    const message = err instanceof z.ZodError ? err.issues[0]?.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    const result = await billing.collectPayment(input);
    return NextResponse.json(result);
  } catch (err) {
    // Overpayment / already-settled come back as plain messages worth showing;
    // anything else is a transport failure the counter should retry.
    const message = err instanceof Error ? err.message : "";
    const isRuleFailure = /already settled|Only ₹|No invoice/.test(message);
    console.error("counter payment failed:", err);
    return NextResponse.json(
      { error: isRuleFailure ? message : "Couldn't record the payment — please try again" },
      { status: isRuleFailure ? 409 : 502 }
    );
  }
}
