import { NextResponse } from "next/server";
import { z } from "zod";
import { isOpsAuthed } from "@/lib/ops/auth";
import { dbConfigured } from "@/lib/pg";
import {
  createCode,
  DuplicateCodeError,
  listCodes,
  listRedemptions,
  setCodeActive,
} from "@/lib/discounts/db";
import {
  DISCOUNT_CHANNELS,
  DISCOUNT_KINDS,
  DISCOUNT_USAGE,
  type DiscountChannel,
} from "@/lib/discounts/types";

export const dynamic = "force-dynamic";

/** Codes and the redemption ledger — everything the discounts page renders. */
export async function GET() {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!dbConfigured()) {
    return NextResponse.json(
      { error: "Discounts need the database — set DATABASE_URL", needsSetup: true },
      { status: 503 }
    );
  }

  try {
    const [codes, redemptions] = await Promise.all([listCodes(), listRedemptions({ limit: 300 })]);
    return NextResponse.json({ codes, redemptions });
  } catch (err) {
    console.error("discount list failed:", err);
    return NextResponse.json({ error: "Couldn't load discount codes" }, { status: 502 });
  }
}

const createSchema = z
  .object({
    // Letters and digits only: a code gets read out over a counter and typed on
    // a phone, so anything that needs explaining doesn't belong in one.
    code: z
      .string()
      .trim()
      .min(3, "Codes need at least 3 characters")
      .max(24)
      .regex(/^[A-Za-z0-9]+$/, "Letters and numbers only"),
    kind: z.enum(DISCOUNT_KINDS),
    value: z.number().positive("Enter a discount"),
    maxDiscount: z.number().positive().nullable().default(null),
    minOrder: z.number().min(0).default(0),
    usage: z.enum(DISCOUNT_USAGE),
    perCustomerLimit: z.number().int().min(1).max(100).nullable().default(null),
    startsAt: z.number().int().nullable().default(null),
    expiresAt: z.number().int().nullable().default(null),
    channels: z.array(z.enum(DISCOUNT_CHANNELS)).min(1, "Pick where it can be used"),
    note: z.string().trim().max(200).default(""),
    /** Employee creating it — the roster picker, same as the expense form. */
    employeeId: z.string().trim().max(60).optional(),
    employeeName: z.string().trim().min(1, "Pick who's creating this").max(60),
  })
  .refine((v) => v.kind !== "percent" || v.value <= 100, {
    message: "A percentage can't be over 100",
    path: ["value"],
  })
  .refine((v) => v.expiresAt == null || v.startsAt == null || v.expiresAt > v.startsAt, {
    message: "The end date has to be after the start",
    path: ["expiresAt"],
  });

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
    const code = await createCode({
      code: input.code,
      kind: input.kind,
      // A cap only means anything on a percentage.
      maxDiscount: input.kind === "percent" ? input.maxDiscount : null,
      value: input.value,
      minOrder: input.minOrder,
      usage: input.usage,
      perCustomerLimit: input.perCustomerLimit,
      startsAt: input.startsAt,
      expiresAt: input.expiresAt,
      channels: input.channels as DiscountChannel[],
      note: input.note,
      createdByEmployeeId: input.employeeId ?? null,
      createdByName: input.employeeName,
    });
    return NextResponse.json({ code });
  } catch (err) {
    if (err instanceof DuplicateCodeError) {
      return NextResponse.json({ error: `${err.code} already exists` }, { status: 409 });
    }
    console.error("discount code creation failed:", err);
    return NextResponse.json({ error: "Couldn't create the code" }, { status: 502 });
  }
}

const patchSchema = z.object({
  id: z.string().min(1),
  active: z.boolean(),
});

/** Switch a code on or off. Codes are never deleted — see lib/discounts/db. */
export async function PATCH(req: Request) {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let input: z.infer<typeof patchSchema>;
  try {
    input = patchSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    const code = await setCodeActive(input.id, input.active);
    if (!code) return NextResponse.json({ error: "No such code" }, { status: 404 });
    return NextResponse.json({ code });
  } catch (err) {
    console.error("discount code update failed:", err);
    return NextResponse.json({ error: "Couldn't update the code" }, { status: 502 });
  }
}
