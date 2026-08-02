import type { Metadata } from "next";
import { isOpsAuthed } from "@/lib/ops/auth";
import OpsLoginGate from "@/components/ops/OpsLoginGate";
import MembersApp from "@/components/members/MembersApp";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Play Panda — Memberships",
  robots: { index: false, follow: false },
};

/**
 * Membership counter (staff only, same password as /ops): look up a member by
 * phone, see plays used/left, punch visits, and record new memberships. The
 * membership SALE is still billed manually in Swipe — this page records it and
 * handles everything after.
 */
export default async function MembersPage() {
  return (await isOpsAuthed()) ? <MembersApp /> : <OpsLoginGate />;
}
