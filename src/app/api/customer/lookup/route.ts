import { NextResponse } from "next/server";
import { billing } from "@/lib/billing";

/**
 * Read-only prefill: given a 10-digit phone, returns the returning customer's
 * name + kids so the form can fill itself in. Returns { found: false } for new
 * numbers, and never errors loudly — prefill is a nicety, not a gate.
 */
export async function GET(req: Request) {
  const phone = new URL(req.url).searchParams.get("phone") ?? "";
  if (!/^[6-9]\d{9}$/.test(phone)) {
    return NextResponse.json({ found: false });
  }

  try {
    const profile = await billing.findCustomerByPhone(phone);
    if (!profile) return NextResponse.json({ found: false });
    return NextResponse.json({ found: true, name: profile.name, kidNames: profile.kidNames });
  } catch (err) {
    console.error("customer lookup failed:", err);
    return NextResponse.json({ found: false });
  }
}
