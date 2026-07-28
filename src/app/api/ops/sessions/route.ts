import { NextResponse } from "next/server";
import { billing } from "@/lib/billing";
import { isOpsAuthed } from "@/lib/ops/auth";
import { getCheckins, getCheckouts } from "@/lib/ops/state";
import type { OpsSession } from "@/lib/ops/types";

export const dynamic = "force-dynamic";

/**
 * Today's sessions for the ops monitor, merged with check-in/out state. The
 * validation code stays server-side — the client only sees `needsCheckIn`.
 */
export async function GET() {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const [sessions, checkins, checkouts] = await Promise.all([
      billing.listTodaySessions(),
      getCheckins(),
      getCheckouts(),
    ]);

    const out: OpsSession[] = sessions.map(({ validationCode, ...s }) => ({
      ...s,
      needsCheckIn: validationCode != null,
      checkinAt: checkins[s.id] ?? null,
      checkoutAt: checkouts[s.id] ?? null,
    }));

    // `checkouts` is echoed raw so the client can apply it to manual
    // (localStorage-only) sessions the server doesn't know about.
    return NextResponse.json({ sessions: out, checkouts });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const needsSetup =
      message.includes("401") || message.includes("token") || message.includes("unauthorized");
    return NextResponse.json(
      { error: `Failed to fetch sessions: ${message}`, needsSetup },
      { status: needsSetup ? 401 : 500 }
    );
  }
}
