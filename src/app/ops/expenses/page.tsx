import type { Metadata } from "next";
import { isOpsAuthed } from "@/lib/ops/auth";
import ExpenseBoard from "@/components/ops/ExpenseBoard";
import OpsLoginGate from "@/components/ops/OpsLoginGate";
import OpsNav from "@/components/ops/OpsNav";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Play Panda — Expenses",
  robots: { index: false, follow: false },
};

/** This month's spend, raised straight into Swipe. */
export default async function OpsExpenseBoardPage() {
  if (!(await isOpsAuthed())) return <OpsLoginGate />;
  return (
    <>
      <OpsNav />
      <ExpenseBoard />
    </>
  );
}
