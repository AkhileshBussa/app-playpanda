import type { Metadata } from "next";
import { isOpsAuthed } from "@/lib/ops/auth";
import OpsDashboard from "@/components/ops/OpsDashboard";
import OpsLoginGate from "@/components/ops/OpsLoginGate";
import OpsNav from "@/components/ops/OpsNav";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Play Panda — Session Monitor",
  robots: { index: false, follow: false },
};

/**
 * Ops session monitor (staff only). App bookings appear as "Waiting" until the
 * manager validates the customer's 4-digit code — that check-in is when the
 * play timer starts. Counter walk-ins run from invoice time, as in pp-billing.
 */
export default async function OpsPage() {
  if (!(await isOpsAuthed())) return <OpsLoginGate />;

  return (
    <>
      <OpsNav />
      <OpsDashboard />
    </>
  );
}
