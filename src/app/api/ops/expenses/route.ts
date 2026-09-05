import { NextResponse } from "next/server";
import { z } from "zod";
import { isOpsAuthed } from "@/lib/ops/auth";
import { istToday } from "@/lib/ledger/dates";
import {
  addExpenseCategory,
  createExpense,
  listExpenses,
  monthRange,
  PAYMENT_MODES,
  swipeDateFromDay,
} from "@/lib/staff/expenses";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  amount: z.number().positive("Amount must be more than ₹0").max(10_000_000),
  categoryId: z.number().int(),
  category: z.string().trim().min(1, "Pick a category"),
  /** Set instead of categoryId/category to create the category on the fly. */
  newCategory: z.string().trim().max(60).optional(),
  description: z.string().trim().min(1, "Say what it was for").max(300),
  paymentMode: z.enum(PAYMENT_MODES),
  /** IST day the money actually went out, "YYYY-MM-DD". Omitted means today —
   *  which is what the form sends unless someone changes it. */
  spentOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date").optional(),
  /** Employee raising it. Optional here so the form still works if the roster
   *  can't load; the form itself requires a pick whenever it has one to offer. */
  addedBy: z.string().trim().min(1).max(60).optional(),
  attachments: z.array(z.string().url()).max(5).default([]),
});

/** This month's expenses, straight from Swipe — no local copy to drift. */
export async function GET(req: Request) {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const monthParam = new URL(req.url).searchParams.get("month");
  // month=YYYY-MM lets the page page back; anything else means this month.
  const base = monthParam && /^\d{4}-\d{2}$/.test(monthParam)
    ? new Date(`${monthParam}-15T00:00:00+05:30`)
    : new Date();
  const range = monthRange(base);

  try {
    const data = await listExpenses(range.from, range.to);
    return NextResponse.json({ ...data, range });
  } catch (err) {
    console.error("expense list failed:", err);
    const message =
      err instanceof Error && err.message.includes("No Swipe token")
        ? "Swipe token missing or expired — refresh it from pp-billing → Settings"
        : "Couldn't load expenses from Swipe";
    return NextResponse.json({ error: message, needsSetup: true }, { status: 502 });
  }
}

/** Raise an expense in Swipe. */
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

  // An expense is money already gone; it can't have gone out tomorrow.
  if (input.spentOn && input.spentOn > istToday()) {
    return NextResponse.json({ error: "That day hasn't happened yet" }, { status: 400 });
  }

  try {
    // A brand-new category has to exist in Swipe before the expense can cite it.
    let { categoryId, category } = input;
    if (input.newCategory) {
      const made = await addExpenseCategory(input.newCategory);
      categoryId = made.categoryId;
      category = made.category;
    }

    const result = await createExpense({
      amount: input.amount,
      categoryId,
      category,
      description: input.description,
      paymentMode: input.paymentMode,
      expenseDate: input.spentOn ? swipeDateFromDay(input.spentOn) : undefined,
      addedBy: input.addedBy,
      attachments: input.attachments,
    });
    return NextResponse.json({ expense: result });
  } catch (err) {
    console.error("expense create failed:", err);
    return NextResponse.json(
      { error: "Swipe rejected the expense — please retry or raise it in Swipe" },
      { status: 502 }
    );
  }
}
