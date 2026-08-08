import { NextResponse } from "next/server";
import { z } from "zod";
import { isOpsAuthed } from "@/lib/ops/auth";
import { currentEmployeeId } from "@/lib/staff/auth";
import { createIssue, getEmployee, listIssues, updateIssueStatus } from "@/lib/staff/db";
import { ISSUE_KINDS, ISSUE_PRIORITIES, ISSUE_STATUSES } from "@/lib/staff/types";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  kind: z.enum(ISSUE_KINDS),
  title: z.string().trim().min(1, "Say what's wrong").max(120),
  details: z.string().trim().max(1000).default(""),
  priority: z.enum(ISSUE_PRIORITIES).default("normal"),
  photoUrl: z.string().url().or(z.literal("")).default(""),
});

const updateSchema = z.object({
  id: z.string().min(1),
  status: z.enum(ISSUE_STATUSES),
  note: z.string().trim().max(300).default(""),
});

/**
 * Whoever is at the counter can raise an issue — a broken slide should not
 * wait for the manager to walk over. Either credential opens this route.
 */
async function canReport(): Promise<string | null> {
  const employeeId = await currentEmployeeId();
  if (employeeId) {
    const employee = await getEmployee(employeeId);
    if (employee?.active) return employee.name;
  }
  return (await isOpsAuthed()) ? "Manager" : null;
}

export async function GET(req: Request) {
  if (!(await isOpsAuthed()) && !(await currentEmployeeId())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const statusParam = new URL(req.url).searchParams.get("status");
  const status = ISSUE_STATUSES.find((s) => s === statusParam);

  try {
    return NextResponse.json({ issues: await listIssues(status) });
  } catch (err) {
    console.error("issue list failed:", err);
    const message =
      err instanceof Error && err.message.includes("DATABASE_URL")
        ? "Postgres isn't configured — set DATABASE_URL"
        : "Couldn't load issues";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

export async function POST(req: Request) {
  const reporter = await canReport();
  if (!reporter) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let input: z.infer<typeof createSchema>;
  try {
    input = createSchema.parse(await req.json());
  } catch (err) {
    const message = err instanceof z.ZodError ? err.issues[0]?.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    const issue = await createIssue({ ...input, reportedByName: reporter });
    return NextResponse.json({ issue });
  } catch (err) {
    console.error("issue create failed:", err);
    return NextResponse.json({ error: "Couldn't save — please retry" }, { status: 502 });
  }
}

/** Move an issue along. Closing one out is a manager call. */
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
    const issue = await updateIssueStatus(input.id, input.status, input.note);
    if (!issue) return NextResponse.json({ error: "Issue not found" }, { status: 404 });
    return NextResponse.json({ issue });
  } catch (err) {
    console.error("issue update failed:", err);
    return NextResponse.json({ error: "Couldn't save — please retry" }, { status: 502 });
  }
}
