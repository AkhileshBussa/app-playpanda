import { NextResponse } from "next/server";
import { isOpsAuthed } from "@/lib/ops/auth";
import { todayIST } from "@/lib/ops/state";
import { billing } from "@/lib/billing";
import { listMembershipsByPhone, listVisits, membersDbConfigured } from "@/lib/members/db";
import {
  membershipStatus,
  normalizePhone,
  playsLeft,
  type MembershipStatus,
} from "@/lib/members/types";

export const dynamic = "force-dynamic";

/** Punchable first, then spent, then gone. */
const STATUS_RANK: Record<MembershipStatus, number> = {
  active: 0,
  exhausted: 1,
  expired: 2,
  deleted: 3,
};

/**
 * Counter lookup: all memberships (with visits + plays left) for a phone
 * number, plus the Swipe customer profile for prefilling a new membership.
 */
export async function GET(req: Request) {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!membersDbConfigured()) {
    return NextResponse.json(
      { error: "Membership database not set up yet — set DATABASE_URL (see docs/memberships.md)" },
      { status: 503 }
    );
  }

  const phone = normalizePhone(new URL(req.url).searchParams.get("phone") ?? "");
  if (!/^\d{10}$/.test(phone)) {
    return NextResponse.json({ error: "Enter a 10-digit phone number" }, { status: 400 });
  }

  try {
    const [memberships, customer] = await Promise.all([
      listMembershipsByPhone(phone),
      // Swipe being down shouldn't block the membership lookup — prefill is a nicety.
      billing.findCustomerByPhone(phone).catch((err) => {
        console.error("customer prefill lookup failed:", err);
        return null;
      }),
    ]);

    const today = todayIST();
    const detailed = await Promise.all(
      memberships.map(async (m) => ({
        ...m,
        playsLeft: playsLeft(m),
        status: membershipStatus(m, today),
        visits: await listVisits(m.id),
      }))
    );

    // Order for the counter, not for the archive: the membership that should
    // be burned first comes first. Usable ones lead, soonest expiry at the top
    // (use-it-or-lose-it), then the ones with least left; everything spent or
    // gone sinks below, newest first.
    detailed.sort((a, b) => {
      if (STATUS_RANK[a.status] !== STATUS_RANK[b.status]) {
        return STATUS_RANK[a.status] - STATUS_RANK[b.status];
      }
      if (a.status === "active") {
        const byExpiry = a.expiresOn.localeCompare(b.expiresOn);
        if (byExpiry !== 0) return byExpiry;
        // Unlimited passes have nothing to run out, so they yield to counted ones.
        const aLeft = a.playsLeft ?? Number.MAX_SAFE_INTEGER;
        const bLeft = b.playsLeft ?? Number.MAX_SAFE_INTEGER;
        if (aLeft !== bLeft) return aLeft - bLeft;
      }
      return b.createdAt - a.createdAt;
    });

    return NextResponse.json({ phone, customer, memberships: detailed });
  } catch (err) {
    console.error("members lookup failed:", err);
    return NextResponse.json({ error: "Couldn't load memberships — please try again" }, { status: 502 });
  }
}
