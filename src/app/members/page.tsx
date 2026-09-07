import type { Metadata } from "next";
import { isOpsAuthed } from "@/lib/ops/auth";
import OpsLoginGate from "@/components/ops/OpsLoginGate";
import OpsNav from "@/components/ops/OpsNav";
import MembersApp from "@/components/members/MembersApp";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Play Panda — Memberships",
  robots: { index: false, follow: false },
};

/**
 * Membership counter (staff only, same password as /ops): look up a member by
 * phone, see plays used/left, punch visits, and sell new memberships — the
 * sale itself is billed into Swipe from /members/new, not by hand.
 */
export default async function MembersPage() {
  if (!(await isOpsAuthed())) return <OpsLoginGate />;

  return (
    <>
      <OpsNav />
      <MembersApp />
    </>
  );
}
