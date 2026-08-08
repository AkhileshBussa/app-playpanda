import { NextResponse } from "next/server";
import { z } from "zod";
import { isOpsAuthed } from "@/lib/ops/auth";
import { decideLeave, listLeaves } from "@/lib/staff/db";

export const dynamic = "force-dynamic";

const decideSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["approved", "rejected"]),
  note: z.string().trim().max(300).default(""),
});

/** Every leave request, newest range first — including the manager's own. */
export async function GET() {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({ leaves: await listLeaves() });
  } catch (err) {
    console.error("ops leave list failed:", err);
    return NextResponse.json({ error: "Couldn't load leave" }, { status: 502 });
  }
}

/** Approve or reject. Holding the ops password is what makes you the manager. */
export async function PATCH(req: Request) {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let input: z.infer<typeof decideSchema>;
  try {
    input = decideSchema.parse(await req.json());
  } catch (err) {
    const message = err instanceof z.ZodError ? err.issues[0]?.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    const leave = await decideLeave(input.id, input.status, "Manager", input.note);
    if (!leave) return NextResponse.json({ error: "Leave request not found" }, { status: 404 });
    return NextResponse.json({ leave });
  } catch (err) {
    console.error("leave decision failed:", err);
    return NextResponse.json({ error: "Couldn't save — please retry" }, { status: 502 });
  }
}
