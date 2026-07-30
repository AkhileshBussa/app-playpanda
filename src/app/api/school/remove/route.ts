import { NextResponse } from "next/server";
import { z } from "zod";
import { isOpsAuthed } from "@/lib/ops/auth";
import { removeSchoolKid } from "@/lib/school";

export const dynamic = "force-dynamic";

const removeSchema = z.object({
  id: z.string().min(1),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

/** Remove a noted kid (typo / duplicate). HDEL is atomic; removing an entry
 * someone else already removed is a harmless no-op. */
export async function POST(req: Request) {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let input: z.infer<typeof removeSchema>;
  try {
    input = removeSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    await removeSchoolKid(input.id, input.date);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("school remove failed:", err);
    return NextResponse.json({ error: "Couldn't remove — please try again" }, { status: 502 });
  }
}
