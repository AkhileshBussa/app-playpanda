import { NextResponse } from "next/server";
import { isOpsAuthed } from "@/lib/ops/auth";
import { listSchoolKids } from "@/lib/school";

export const dynamic = "force-dynamic";

/** Today's school-visit log (staff only). ?date=YYYY-MM-DD views another day. */
export async function GET(req: Request) {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const date = new URL(req.url).searchParams.get("date") ?? undefined;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "Invalid date" }, { status: 400 });
  }

  try {
    const entries = await listSchoolKids(date);
    return NextResponse.json({ entries });
  } catch (err) {
    console.error("school list failed:", err);
    return NextResponse.json({ error: "Couldn't load the list" }, { status: 502 });
  }
}
