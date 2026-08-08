import type { Metadata } from "next";
import { isOpsAuthed } from "@/lib/ops/auth";
import EmployeeManager from "@/components/ops/EmployeeManager";
import OpsLoginGate from "@/components/ops/OpsLoginGate";
import OpsNav from "@/components/ops/OpsNav";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Play Panda — Employees",
  robots: { index: false, follow: false },
};

/** Add, edit and deactivate the team; reset PINs. */
export default async function OpsEmployeeManagerPage() {
  if (!(await isOpsAuthed())) return <OpsLoginGate />;
  return (
    <>
      <OpsNav />
      <EmployeeManager />
    </>
  );
}
