import type { Metadata } from "next";
import { isAdminAuthed, isOpsAuthed } from "@/lib/ops/auth";
import OpsLoginGate from "@/components/ops/OpsLoginGate";
import OpsNav from "@/components/ops/OpsNav";
import StockBoard from "@/components/ops/StockBoard";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Play Panda — Stock",
  robots: { index: false, follow: false },
};

/**
 * What's on the shelves. The counter sees quantities — what's running out is
 * floor knowledge — while cost, margin and stock value are owner figures and
 * are left out of the counter's response entirely.
 */
export default async function OpsStockPage() {
  if (!(await isOpsAuthed())) return <OpsLoginGate />;
  return (
    <>
      <OpsNav />
      <StockBoard isAdmin={await isAdminAuthed()} />
    </>
  );
}
