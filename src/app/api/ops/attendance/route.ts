import { NextResponse } from "next/server";
import { isOpsAuthed } from "@/lib/ops/auth";
import { attendanceForDay, listAttendanceBetween, listLeaves } from "@/lib/staff/db";
import { todayIST } from "@/lib/ops/state";
import { PLAYZONE } from "@/lib/staff/geo";

export const dynamic = "force-dynamic";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Shift `day` (IST YYYY-MM-DD) by n days. */
function shiftDay(day: string, n: number): string {
  const t = Date.parse(`${day}T00:00:00Z`) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * The manager's attendance view: today's roster with who's in, out, absent or
 * on leave — plus the last fortnight's entries and every leave request.
 */
export async function GET(req: Request) {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const param = new URL(req.url).searchParams.get("day");
  const day = param && ISO_DAY.test(param) ? param : todayIST();

  try {
    const [rows, history, leaves] = await Promise.all([
      attendanceForDay(day),
      listAttendanceBetween(shiftDay(day, -13), day),
      listLeaves(),
    ]);
    return NextResponse.json({
      day,
      today: todayIST(),
      rows,
      history,
      leaves,
      geofenceRadiusM: PLAYZONE.radiusM,
    });
  } catch (err) {
    console.error("ops attendance load failed:", err);
    const message =
      err instanceof Error && err.message.includes("DATABASE_URL")
        ? "Postgres isn't configured — set DATABASE_URL"
        : "Couldn't load attendance";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
