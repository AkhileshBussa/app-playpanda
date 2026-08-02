import type { Metadata } from "next";
import { isOpsAuthed } from "@/lib/ops/auth";
import OpsLoginGate from "@/components/ops/OpsLoginGate";
import OpsNav from "@/components/ops/OpsNav";
import SchoolLog from "@/components/school/SchoolLog";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Play Panda — School Visit Log",
  robots: { index: false, follow: false },
};

/**
 * Shared kid log for school partnership visits (staff only, same password as
 * /ops). Several staff can note kids at the same time — entries sync between
 * devices automatically.
 */
export default async function SchoolPage() {
  if (!(await isOpsAuthed())) return <OpsLoginGate />;

  return (
    <>
      <OpsNav />
      <SchoolLog />
    </>
  );
}
