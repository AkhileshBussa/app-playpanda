import type { Metadata } from "next";
import { isOpsAuthed } from "@/lib/ops/auth";
import FeedbackBoard from "@/components/ops/FeedbackBoard";
import OpsLoginGate from "@/components/ops/OpsLoginGate";
import OpsNav from "@/components/ops/OpsNav";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Play Panda — Customer feedback",
  robots: { index: false, follow: false },
};

/** What customers said after their visit. */
export default async function OpsFeedbackBoardPage() {
  if (!(await isOpsAuthed())) return <OpsLoginGate />;
  return (
    <>
      <OpsNav />
      <FeedbackBoard />
    </>
  );
}
