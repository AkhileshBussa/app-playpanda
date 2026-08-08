import { NextResponse } from "next/server";
import { isOpsAuthed } from "@/lib/ops/auth";
import { attendanceForDay } from "@/lib/staff/db";
import { todayIST } from "@/lib/ops/state";

export const dynamic = "force-dynamic";

/** Nobody is chased before this hour, IST. (Not exported — Next.js only
 *  allows its own set of named exports from a route file.) */
const CUTOFF_HOUR = 12;

/** Current hour in IST, 0–23. */
function hourIST(): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      hour12: false,
    }).format(new Date())
  );
}

/**
 * Deliberately small and cheap: the session monitor polls this every 30s
 * alongside the sessions themselves, so it returns names and nothing else.
 *
 * Someone with approved leave isn't missing — they're off. A *pending* leave
 * request still counts as missing, because nobody has agreed to it yet.
 */
export async function GET() {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const past = hourIST() >= CUTOFF_HOUR;
  if (!past) return NextResponse.json({ past: false, missing: [] });

  try {
    const rows = await attendanceForDay(todayIST());
    const missing = rows
      .filter((r) => !r.entry && !r.onLeave)
      .map((r) => ({ id: r.employee.id, name: r.employee.name }));
    return NextResponse.json({ past: true, missing, cutoffHour: CUTOFF_HOUR });
  } catch (err) {
    // The alert is a nicety on someone else's page — never break the session
    // monitor because the staff database is unreachable.
    console.error("attendance alert failed:", err);
    return NextResponse.json({ past: false, missing: [] });
  }
}
