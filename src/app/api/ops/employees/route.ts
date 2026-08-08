import { NextResponse } from "next/server";
import { z } from "zod";
import { isOpsAuthed } from "@/lib/ops/auth";
import { hashPin } from "@/lib/staff/auth";
import { clearFailures } from "@/lib/staff/ratelimit";
import { createEmployee, listEmployees, updateEmployee } from "@/lib/staff/db";

export const dynamic = "force-dynamic";

const PIN = z.string().regex(/^\d{4}$/, "PIN must be exactly 4 digits");

const createSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(60),
  phone: z.string().trim().regex(/^\d{10}$|^$/, "Phone must be 10 digits").default(""),
  role: z.enum(["staff", "manager"]).default("staff"),
  pin: PIN,
});

const updateSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(60).optional(),
  phone: z.string().trim().regex(/^\d{10}$|^$/, "Phone must be 10 digits").optional(),
  role: z.enum(["staff", "manager"]).optional(),
  active: z.boolean().optional(),
  /** Set to reset a forgotten PIN; also clears any lockout. */
  pin: PIN.optional(),
});

/** The full roster, inactive included — this is the management view. */
export async function GET() {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({ employees: await listEmployees(true) });
  } catch (err) {
    console.error("employee list failed:", err);
    const message =
      err instanceof Error && err.message.includes("DATABASE_URL")
        ? "Postgres isn't configured — set DATABASE_URL"
        : "Couldn't load employees";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

export async function POST(req: Request) {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let input: z.infer<typeof createSchema>;
  try {
    input = createSchema.parse(await req.json());
  } catch (err) {
    const message = err instanceof z.ZodError ? err.issues[0]?.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    const employee = await createEmployee({
      name: input.name,
      phone: input.phone,
      role: input.role,
      pinHash: await hashPin(input.pin),
    });
    return NextResponse.json({ employee });
  } catch (err) {
    console.error("employee create failed:", err);
    return NextResponse.json({ error: "Couldn't add — please retry" }, { status: 502 });
  }
}

/**
 * Edit an employee, deactivate them, or reset their PIN. Employees are never
 * deleted — attendance and leave rows point at them, and the history is the
 * point of the tool. Deactivating just takes them off the check-in picker.
 */
export async function PATCH(req: Request) {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let input: z.infer<typeof updateSchema>;
  try {
    input = updateSchema.parse(await req.json());
  } catch (err) {
    const message = err instanceof z.ZodError ? err.issues[0]?.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    const employee = await updateEmployee(input.id, {
      name: input.name,
      phone: input.phone,
      role: input.role,
      active: input.active,
      pinHash: input.pin ? await hashPin(input.pin) : undefined,
    });
    if (!employee) return NextResponse.json({ error: "Employee not found" }, { status: 404 });
    if (input.pin) await clearFailures(input.id);
    return NextResponse.json({ employee });
  } catch (err) {
    console.error("employee update failed:", err);
    return NextResponse.json({ error: "Couldn't save — please retry" }, { status: 502 });
  }
}
