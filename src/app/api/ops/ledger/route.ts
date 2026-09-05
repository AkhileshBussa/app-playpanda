import { NextResponse } from "next/server";
import { z } from "zod";
import { isAdminAuthed, isOpsAuthed } from "@/lib/ops/auth";
import { isDay, isMonth, istToday, monthOf } from "@/lib/ledger/dates";
import { declareDay } from "@/lib/ledger/db";
import { buildLedgerMonth } from "@/lib/ledger/month";

export const dynamic = "force-dynamic";

const AMOUNT = z.number().min(0, "Amounts can't be negative").max(10_000_000);

const declareSchema = z.object({
  day: z.string().refine(isDay, "Pick a day"),
  cashInr: AMOUNT,
  onlineInr: AMOUNT,
  note: z.string().trim().max(300).default(""),
  /** Who counted it. A shared password can't say, so the form asks. */
  enteredBy: z.string().trim().max(60).default(""),
});

/**
 * One month of the ledger.
 *
 * The counter and the owner hit the same URL; the owner's response simply
 * carries more. The Swipe tally is added by the assembler only for admins, so
 * the counter's copy of this payload never contains it.
 */
export async function GET(req: Request) {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const param = new URL(req.url).searchParams.get("month");
  const month = param && isMonth(param) ? param : monthOf(istToday());
  const isAdmin = await isAdminAuthed();

  try {
    const ledger = await buildLedgerMonth(month, isAdmin);
    return NextResponse.json({ ledger, isAdmin });
  } catch (err) {
    console.error("ledger load failed:", err);
    return NextResponse.json({ error: "Couldn't load the ledger" }, { status: 500 });
  }
}

/** Declare a day's takings. Re-declaring corrects the day, never doubles it. */
export async function POST(req: Request) {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let input: z.infer<typeof declareSchema>;
  try {
    input = declareSchema.parse(await req.json());
  } catch (err) {
    const message = err instanceof z.ZodError ? err.issues[0]?.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  // A day that hasn't happened can't have been counted.
  if (input.day > istToday()) {
    return NextResponse.json({ error: "That day hasn't happened yet" }, { status: 400 });
  }

  try {
    // The name is what they picked on the form; the tier is what their cookie
    // actually proves. Both go into the history — when they disagree, the
    // tier is the one worth believing.
    const declaration = await declareDay({
      ...input,
      actor: { name: input.enteredBy, tier: (await isAdminAuthed()) ? "owner" : "counter" },
    });
    return NextResponse.json({ declaration });
  } catch (err) {
    console.error("ledger declare failed:", err);
    return NextResponse.json({ error: "Couldn't save the day" }, { status: 500 });
  }
}
