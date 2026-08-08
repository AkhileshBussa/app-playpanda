import type { Metadata } from "next";
import { isOpsAuthed } from "@/lib/ops/auth";
import IssueBoard from "@/components/ops/IssueBoard";
import OpsLoginGate from "@/components/ops/OpsLoginGate";
import OpsNav from "@/components/ops/OpsNav";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Play Panda — Issues & repairs",
  robots: { index: false, follow: false },
};

/** Report and track what needs fixing. */
export default async function OpsIssueBoardPage() {
  if (!(await isOpsAuthed())) return <OpsLoginGate />;
  return (
    <>
      <OpsNav />
      <IssueBoard />
    </>
  );
}
