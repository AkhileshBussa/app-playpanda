import type { Metadata } from "next";
import { isAdminAuthed, isOpsAuthed } from "@/lib/ops/auth";
import { listStockProducts } from "@/lib/inventory/products";
import OpsLoginGate from "@/components/ops/OpsLoginGate";
import OpsNav from "@/components/ops/OpsNav";
import PurchaseBoard from "@/components/ops/PurchaseBoard";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Play Panda — Purchases",
  robots: { index: false, follow: false },
};

/**
 * Stock buying. The catalogue is fetched here rather than in the browser
 * because the new-purchase sheet needs it the moment it opens, and waiting on
 * a Swipe round-trip after the tap would be the slowest part of recording a
 * delivery.
 */
export default async function OpsPurchasesPage() {
  if (!(await isOpsAuthed())) return <OpsLoginGate />;

  const [isAdmin, products] = await Promise.all([
    isAdminAuthed(),
    listStockProducts().catch(() => []),
  ]);

  return (
    <>
      <OpsNav />
      <PurchaseBoard isAdmin={isAdmin} products={products} />
    </>
  );
}
