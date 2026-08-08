import { NextResponse } from "next/server";
import { z } from "zod";
import { isOpsAuthed } from "@/lib/ops/auth";
import { createFeedback, listFeedback, updateFeedback } from "@/lib/staff/db";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  rating: z.number().int().min(1).max(5),
});

const followUpSchema = z.object({
  id: z.string().min(1),
  improve: z.string().trim().max(1000).optional(),
  name: z.string().trim().max(60).optional(),
  phone: z.string().trim().regex(/^\d{10}$|^$/, "Phone must be 10 digits").optional(),
  sentToGoogle: z.boolean().optional(),
});

/**
 * PUBLIC — customers rate the playzone from /feedback, no auth.
 *
 * The star goes in on its own request, before we ask anything else: a customer
 * who taps 2 stars and walks off still tells us something, and that's exactly
 * the rating we'd otherwise never hear about.
 */
export async function POST(req: Request) {
  let input: z.infer<typeof createSchema>;
  try {
    input = createSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Pick a rating" }, { status: 400 });
  }

  try {
    const feedback = await createFeedback({
      rating: input.rating,
      improve: "",
      name: "",
      phone: "",
      sentToGoogle: false,
    });
    return NextResponse.json({ id: feedback.id });
  } catch (err) {
    console.error("feedback create failed:", err);
    return NextResponse.json({ error: "Couldn't save — please retry" }, { status: 502 });
  }
}

/** PUBLIC — the second step: what to improve, or the Google hand-off. */
export async function PATCH(req: Request) {
  let input: z.infer<typeof followUpSchema>;
  try {
    input = followUpSchema.parse(await req.json());
  } catch (err) {
    const message = err instanceof z.ZodError ? err.issues[0]?.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    const feedback = await updateFeedback(input.id, input);
    if (!feedback) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("feedback update failed:", err);
    return NextResponse.json({ error: "Couldn't save — please retry" }, { status: 502 });
  }
}

/** Staff only — the ops feedback page. */
export async function GET() {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({ feedback: await listFeedback() });
  } catch (err) {
    console.error("feedback list failed:", err);
    const message =
      err instanceof Error && err.message.includes("DATABASE_URL")
        ? "Postgres isn't configured — set DATABASE_URL"
        : "Couldn't load feedback";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
