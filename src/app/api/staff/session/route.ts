import { NextResponse } from "next/server";
import { z } from "zod";
import { currentEmployeeId, staffCookie, verifyPin } from "@/lib/staff/auth";
import { checkLockout, clearFailures, recordFailure, LOCKOUT_MESSAGE } from "@/lib/staff/ratelimit";
import {
  getAttendance,
  getEmployee,
  getEmployeePinHash,
  listEmployees,
  listLeaves,
} from "@/lib/staff/db";
import { STAFF_COOKIE } from "@/lib/staff/auth";
import { todayIST } from "@/lib/ops/state";

export const dynamic = "force-dynamic";

const loginSchema = z.object({
  employeeId: z.string().min(1),
  pin: z.string().regex(/^\d{4}$/, "PIN must be 4 digits"),
});

/**
 * Who's signed in, plus everything the /staff page needs to render: the name
 * picker, today's attendance, and this employee's leave. Unauthenticated
 * callers get only the picker — names are not a secret, PINs are.
 */
export async function GET() {
  try {
    const employees = await listEmployees();
    const roster = employees.map((e) => ({ id: e.id, name: e.name, role: e.role }));
    const employeeId = await currentEmployeeId();
    if (!employeeId) {
      return NextResponse.json({ roster, employee: null });
    }

    const employee = await getEmployee(employeeId);
    if (!employee || !employee.active) {
      // Removed or deactivated mid-session — drop the cookie rather than 500.
      const res = NextResponse.json({ roster, employee: null });
      res.cookies.delete(STAFF_COOKIE);
      return res;
    }

    const [today, leaves] = await Promise.all([
      getAttendance(employeeId, todayIST()),
      listLeaves({ employeeId }),
    ]);
    return NextResponse.json({
      roster,
      employee,
      today,
      leaves,
      workDate: todayIST(),
    });
  } catch (err) {
    console.error("staff session load failed:", err);
    return NextResponse.json({ error: "Couldn't load — please retry" }, { status: 502 });
  }
}

/** Sign in with a 4-digit PIN. */
export async function POST(req: Request) {
  let input: z.infer<typeof loginSchema>;
  try {
    input = loginSchema.parse(await req.json());
  } catch (err) {
    const message = err instanceof z.ZodError ? err.issues[0]?.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    if ((await checkLockout(input.employeeId)).locked) {
      return NextResponse.json({ error: LOCKOUT_MESSAGE }, { status: 429 });
    }

    const hash = await getEmployeePinHash(input.employeeId);
    // Same message and no early return for an unknown id, so this can't be
    // used to enumerate which employees exist.
    if (!hash || !(await verifyPin(input.pin, hash))) {
      const state = await recordFailure(input.employeeId);
      return NextResponse.json(
        {
          error: state.locked
            ? LOCKOUT_MESSAGE
            : `Wrong PIN — ${state.remaining} ${state.remaining === 1 ? "try" : "tries"} left`,
        },
        { status: 401 }
      );
    }

    await clearFailures(input.employeeId);
    const employee = await getEmployee(input.employeeId);
    const res = NextResponse.json({ employee });
    res.cookies.set(staffCookie(input.employeeId));
    return res;
  } catch (err) {
    console.error("staff login failed:", err);
    return NextResponse.json({ error: "Couldn't sign in — please retry" }, { status: 502 });
  }
}

/** Sign out. */
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(STAFF_COOKIE);
  return res;
}
