import { NextResponse } from "next/server";
import { z } from "zod";
import { isOpsAuthed } from "@/lib/ops/auth";
import { addSchoolKid, listSchoolKids } from "@/lib/school";

export const dynamic = "force-dynamic";

const addSchema = z.object({
  kidName: z.string().trim().min(1, "Kid's name is required").max(60),
  className: z.string().trim().min(1, "Class is required").max(30),
  /** Set after the duplicate warning to add the entry anyway. */
  force: z.boolean().optional(),
});

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** Note a kid on today's list (staff only). */
export async function POST(req: Request) {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let input: z.infer<typeof addSchema>;
  try {
    input = addSchema.parse(await req.json());
  } catch (err) {
    const message = err instanceof z.ZodError ? err.issues[0]?.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    // Advisory duplicate check — NOT atomic (two staff adding the same kid in
    // the same instant can still both land), but that's fine: entries never
    // overwrite each other, dupes are visible on everyone's list, and any row
    // can be removed. This just catches the common "kid already noted" case.
    if (!input.force) {
      const existing = await listSchoolKids();
      const dup = existing.find(
        (e) => norm(e.kidName) === norm(input.kidName) && norm(e.className) === norm(input.className)
      );
      if (dup) {
        return NextResponse.json({ duplicate: true, existing: dup }, { status: 409 });
      }
    }

    const entry = await addSchoolKid(input.kidName, input.className);
    return NextResponse.json({ entry });
  } catch (err) {
    console.error("school add failed:", err);
    return NextResponse.json(
      { error: "Couldn't save — please try again" },
      { status: 502 }
    );
  }
}
