import { NextResponse } from "next/server";
import { z } from "zod";
import { currentEmployeeId } from "@/lib/staff/auth";
import { AttendanceError, checkIn, checkOut } from "@/lib/staff/db";
import { checkFence } from "@/lib/staff/geo";
import { todayIST } from "@/lib/ops/state";

export const dynamic = "force-dynamic";

const markSchema = z.object({
  action: z.enum(["in", "out"]),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyM: z.number().min(0).max(100_000),
});

/**
 * Mark attendance. The geofence is enforced HERE, not in the browser — the
 * page can be edited by anyone holding the phone, so its check is only there
 * to give a fast, kind error message.
 */
export async function POST(req: Request) {
  const employeeId = await currentEmployeeId();
  if (!employeeId) {
    return NextResponse.json({ error: "Sign in with your PIN first" }, { status: 401 });
  }

  let input: z.infer<typeof markSchema>;
  try {
    input = markSchema.parse(await req.json());
  } catch (err) {
    const message =
      err instanceof z.ZodError
        ? "Couldn't read your location — allow location access and try again"
        : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const verdict = checkFence(input);
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.error, distanceM: verdict.distanceM }, { status: 403 });
  }

  const fix = {
    lat: input.lat,
    lng: input.lng,
    accuracyM: input.accuracyM,
    distanceM: verdict.distanceM,
  };

  try {
    const entry =
      input.action === "in"
        ? await checkIn({ employeeId, workDate: todayIST(), at: Date.now(), fix })
        : await checkOut({ employeeId, workDate: todayIST(), at: Date.now(), fix });
    return NextResponse.json({ entry });
  } catch (err) {
    if (err instanceof AttendanceError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error("attendance mark failed:", err);
    return NextResponse.json({ error: "Couldn't save — please retry" }, { status: 502 });
  }
}
