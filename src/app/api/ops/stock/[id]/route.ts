import { NextResponse } from "next/server";
import { isAdminAuthed, isOpsAuthed } from "@/lib/ops/auth";
import { listStockMovements } from "@/lib/inventory/products";
import { listProductChanges } from "@/lib/inventory/history";

export const dynamic = "force-dynamic";

/**
 * One product's story: every movement of its stock, and every change to the
 * product itself.
 *
 * The two come from different places for a good reason. Movements are Swipe's
 * — its inventory timeline, so each line maps to a real invoice or purchase
 * rather than to something inferred here. The change history is ours, because
 * Swipe keeps none and can't say who touched a price.
 *
 * Prices on the movement lines are owner figures, like everywhere else; the
 * counter sees what moved and on which document, not what it was worth.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Bad product id" }, { status: 400 });
  }

  const isAdmin = await isAdminAuthed();

  // The history is ours and cheap; the timeline is Swipe's and can be down.
  // One failing shouldn't blank the other.
  const [movements, changes] = await Promise.all([
    listStockMovements(id).catch((err) => {
      console.error("stock movements failed:", err);
      return null;
    }),
    listProductChanges(id).catch((err) => {
      console.error("product history failed:", err);
      return [];
    }),
  ]);

  return NextResponse.json({
    movements:
      movements === null
        ? null
        : movements.map((m) => (isAdmin ? m : { ...m, priceInr: 0 })),
    movementsError: movements === null ? "Couldn't read stock movements from Swipe." : null,
    changes,
    isAdmin,
  });
}
