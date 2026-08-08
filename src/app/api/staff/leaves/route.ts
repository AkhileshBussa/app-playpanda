import { NextResponse } from "next/server";
import { z } from "zod";
import { currentEmployeeId } from "@/lib/staff/auth";
import { countDays, createLeave, listLeaves } from "@/lib/staff/db";
import { LEAVE_TYPES } from "@/lib/staff/types";

export const dynamic = "force-dynamic";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A whole season of leave in one request is a typo, not a plan. */
const MAX_LEAVE_DAYS = 60;

const applySchema = z
  .object({
    fromDate: z.string().regex(ISO_DAY, "Pick a start date"),
    toDate: z.string().regex(ISO_DAY, "Pick an end date"),
    leaveType: z.enum(LEAVE_TYPES),
    reason: z.string().trim().max(500).default(""),
  })
  .refine((v) => v.toDate >= v.fromDate, {
    message: "The last day can't be before the first day",
    path: ["toDate"],
  })
  .refine((v) => countDays(v.fromDate, v.toDate) <= MAX_LEAVE_DAYS, {
    message: `That's more than ${MAX_LEAVE_DAYS} days — split it into shorter requests`,
    path: ["toDate"],
  });

/** This employee's own leave history. */
export async function GET() {
  const employeeId = await currentEmployeeId();
  if (!employeeId) {
    return NextResponse.json({ error: "Sign in with your PIN first" }, { status: 401 });
  }
  try {
    return NextResponse.json({ leaves: await listLeaves({ employeeId }) });
  } catch (err) {
    console.error("leave list failed:", err);
    return NextResponse.json({ error: "Couldn't load leave" }, { status: 502 });
  }
}

/** Apply for leave — lands as "pending" for the manager to review. */
export async function POST(req: Request) {
  const employeeId = await currentEmployeeId();
  if (!employeeId) {
    return NextResponse.json({ error: "Sign in with your PIN first" }, { status: 401 });
  }

  let input: z.infer<typeof applySchema>;
  try {
    input = applySchema.parse(await req.json());
  } catch (err) {
    const message = err instanceof z.ZodError ? err.issues[0]?.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    const leave = await createLeave({ employeeId, ...input });
    return NextResponse.json({ leave });
  } catch (err) {
    console.error("leave apply failed:", err);
    return NextResponse.json({ error: "Couldn't submit — please retry" }, { status: 502 });
  }
}
