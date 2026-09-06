import { NextResponse } from "next/server";
import { z } from "zod";
import { isAdminAuthed, isOpsAuthed } from "@/lib/ops/auth";
import { createProduct, listStockProducts, updateProduct } from "@/lib/inventory/products";

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

/**
 * The catalogue itself — owner only.
 *
 * What a product costs and what it sells for are pricing decisions, not floor
 * work, and a mistyped cost quietly poisons every margin figure on the page.
 * The counter reads stock; it doesn't set it.
 */
const productSchema = z.object({
  name: z.string().trim().min(1, "Name the product").max(100),
  priceWithTax: z.number().min(0, "Price can't be negative").max(1_000_000),
  // India's GST slabs. Anything else is a typo, and the wrong slab on a
  // product is a tax problem, not a display one.
  taxRatePercent: z.union([z.literal(0), z.literal(5), z.literal(12), z.literal(18), z.literal(28)]),
  unit: z.string().trim().min(1).max(20),
  category: z.string().trim().max(60).default(""),
  costPrice: z.number().min(0).max(1_000_000).default(0),
  lowStockAt: z.number().int().min(0).max(100_000).default(0),
  hsnCode: z.string().trim().max(20).default(""),
});

async function readProduct(req: Request) {
  try {
    return { ok: true as const, input: productSchema.parse(await req.json()) };
  } catch (err) {
    const message = err instanceof z.ZodError ? err.issues[0]?.message : "Invalid request";
    return { ok: false as const, message: message ?? "Invalid request" };
  }
}

/** Add a product to the Swipe catalogue. */
export async function POST(req: Request) {
  if (!(await isAdminAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const parsed = await readProduct(req);
  if (!parsed.ok) return NextResponse.json({ error: parsed.message }, { status: 400 });

  try {
    await createProduct(parsed.input);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("product create failed:", err);
    const message = err instanceof Error ? err.message : "Swipe rejected the product";
    // Swipe's duplicate-name refusal is the one a person can act on.
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

/** Edit one. Everything the form doesn't set is preserved. */
export async function PATCH(req: Request) {
  if (!(await isAdminAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Missing product id" }, { status: 400 });
  }
  const parsed = await readProduct(req);
  if (!parsed.ok) return NextResponse.json({ error: parsed.message }, { status: 400 });

  try {
    await updateProduct(id, parsed.input);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("product update failed:", err);
    const message = err instanceof Error ? err.message : "Swipe rejected the change";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
