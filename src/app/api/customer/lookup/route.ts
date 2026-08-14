import { NextResponse } from "next/server";
import { billing } from "@/lib/billing";
import { getCustomerByPhone } from "@/lib/customers/db";
import { dbConfigured } from "@/lib/pg";

/**
 * Read-only prefill: given a 10-digit phone, returns the returning customer's
 * name + kids so the form can fill itself in. Returns { found: false } for new
 * numbers, and never errors loudly — prefill is a nicety, not a gate.
 *
 * `askHeardFrom` drives the "how did you hear about us?" question: only a
 * genuinely new family gets it — not a returning customer, and not anyone who
 * has already answered it once.
 */
export async function GET(req: Request) {
  const phone = new URL(req.url).searchParams.get("phone") ?? "";
  if (!/^[6-9]\d{9}$/.test(phone)) {
    return NextResponse.json({ found: false, askHeardFrom: false });
  }

  try {
    const [profile, customer] = await Promise.all([
      billing.findCustomerByPhone(phone),
      dbConfigured()
        ? getCustomerByPhone(phone).catch((err) => {
            console.error("customer row lookup failed:", err);
            return null;
          })
        : Promise.resolve(null),
    ]);

    const askHeardFrom = profile == null && customer == null;
    if (!profile) return NextResponse.json({ found: false, askHeardFrom });
    return NextResponse.json({
      found: true,
      name: profile.name,
      kidNames: profile.kidNames,
      askHeardFrom,
    });
  } catch (err) {
    console.error("customer lookup failed:", err);
    return NextResponse.json({ found: false, askHeardFrom: false });
  }
}
