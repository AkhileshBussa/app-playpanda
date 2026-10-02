import { NextResponse } from "next/server";
import { z } from "zod";
import { isAdminAuthed } from "@/lib/ops/auth";
import { dbConfigured } from "@/lib/pg";
import { PRICE_VERSIONS } from "@/lib/pricing";
import {
  getActivePriceVersion,
  listPriceVersionChanges,
  PriceVersionError,
  priceVersionReadiness,
  setActivePriceVersion,
} from "@/lib/settings/priceVersion";

export const dynamic = "force-dynamic";

const switchSchema = z.object({
  version: z.enum(PRICE_VERSIONS),
  changedBy: z.string().trim().min(2, "Enter your name").max(60),
});

async function snapshot() {
  return {
    active: await getActivePriceVersion(),
    ready: priceVersionReadiness(),
    history: await listPriceVersionChanges(),
  };
}

export async function GET() {
  if (!(await isAdminAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json(await snapshot());
  } catch (err) {
    console.error("price version read failed:", err);
    return NextResponse.json({ error: "Couldn't read the price list setting" }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  if (!(await isAdminAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!dbConfigured()) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }

  let input: z.infer<typeof switchSchema>;
  try {
    input = switchSchema.parse(await req.json());
  } catch (err) {
    const message = err instanceof z.ZodError ? err.issues[0]?.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    await setActivePriceVersion(input.version, input.changedBy);
    return NextResponse.json(await snapshot());
  } catch (err) {
    if (err instanceof PriceVersionError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error("price version switch failed:", err);
    return NextResponse.json({ error: "Couldn't switch the price list" }, { status: 500 });
  }
}
