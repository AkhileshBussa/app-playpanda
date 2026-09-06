import { NextResponse } from "next/server";
import { isAdminAuthed, isOpsAuthed } from "@/lib/ops/auth";
import { listStockProducts } from "@/lib/inventory/products";

export const dynamic = "force-dynamic";

/**
 * What's on the shelves, straight from Swipe.
 *
 * Cost prices, stock value and margin are owner figures — the counter needs to
 * know what's running out, not what the tuck shop makes on a bottle of water —
 * so they're stripped from the counter's response rather than hidden in the UI.
 */
export async function GET() {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const isAdmin = await isAdminAuthed();

  try {
    const all = await listStockProducts();
    const products = isAdmin
      ? all
      : all.map(({ costPrice, stockValueInr, marginInr, marginIssue, ...rest }) => {
          void costPrice;
          void stockValueInr;
          void marginInr;
          void marginIssue;
          return { ...rest, costPrice: 0, stockValueInr: 0, marginInr: null, marginIssue: null };
        });

    return NextResponse.json({
      products,
      isAdmin,
      totals: isAdmin
        ? {
            lines: all.length,
            units: all.reduce((sum, p) => sum + p.qty, 0),
            valueInr: all.reduce((sum, p) => sum + p.stockValueInr, 0),
            low: all.filter((p) => p.isLow).length,
            noCost: all.filter((p) => p.marginIssue === "no-cost").length,
            badCost: all.filter((p) => p.marginIssue === "cost-above").length,
            noReorderLevel: all.filter((p) => p.lowStockAt === 0).length,
            negative: all.filter((p) => p.qty < 0).length,
          }
        : {
            lines: all.length,
            units: all.reduce((sum, p) => sum + p.qty, 0),
            valueInr: 0,
            low: all.filter((p) => p.isLow).length,
            noCost: 0,
            badCost: 0,
            noReorderLevel: all.filter((p) => p.lowStockAt === 0).length,
            negative: all.filter((p) => p.qty < 0).length,
          },
    });
  } catch (err) {
    console.error("stock list failed:", err);
    const message =
      err instanceof Error && err.message.includes("No Swipe token")
        ? "Swipe token missing or expired — refresh it from pp-billing → Settings"
        : "Couldn't load stock from Swipe";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
