import type { Metadata } from "next";
import { isOpsAuthed } from "@/lib/ops/auth";
import DiscountBoard from "@/components/ops/DiscountBoard";
import OpsLoginGate from "@/components/ops/OpsLoginGate";
import OpsNav from "@/components/ops/OpsNav";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Play Panda — Discounts",
  robots: { index: false, follow: false },
};

/** Discount codes, and every discount that's actually been given. */
export default async function OpsDiscountsPage() {
  if (!(await isOpsAuthed())) return <OpsLoginGate />;
  return (
    <>
      <OpsNav />
      <DiscountBoard />
    </>
  );
}
