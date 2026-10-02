import type { Metadata } from "next";
import { isAdminAuthed } from "@/lib/ops/auth";
import OpsLoginGate from "@/components/ops/OpsLoginGate";
import OpsNav from "@/components/ops/OpsNav";
import PriceListBoard from "@/components/ops/PriceListBoard";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Play Panda — Price list",
  robots: { index: false, follow: false },
};

export default async function OpsPricingPage() {
  if (!(await isAdminAuthed())) return <OpsLoginGate />;
  return (
    <>
      <OpsNav />
      <PriceListBoard />
    </>
  );
}
