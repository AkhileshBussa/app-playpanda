import type { Metadata } from "next";
import { isOpsAuthed } from "@/lib/ops/auth";
import AttendanceBoard from "@/components/ops/AttendanceBoard";
import OpsLoginGate from "@/components/ops/OpsLoginGate";
import OpsNav from "@/components/ops/OpsNav";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Play Panda — Staff & leave",
  robots: { index: false, follow: false },
};

/** Manager view of attendance and leave. Employees mark themselves at /staff. */
export default async function OpsAttendancePage() {
  if (!(await isOpsAuthed())) return <OpsLoginGate />;
  return (
    <>
      <OpsNav />
      <AttendanceBoard />
    </>
  );
}
