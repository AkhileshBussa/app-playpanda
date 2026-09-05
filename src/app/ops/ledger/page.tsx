import type { Metadata } from "next";
import { isAdminAuthed, isOpsAuthed } from "@/lib/ops/auth";
import LedgerBoard from "@/components/ops/LedgerBoard";
import OpsLoginGate from "@/components/ops/OpsLoginGate";
import OpsNav from "@/components/ops/OpsNav";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Play Panda — Cash ledger",
  robots: { index: false, follow: false },
};

/**
 * The cash ledger. The counter declares each day and logs cash going out; the
 * owner additionally sees it tallied against Swipe.
 *
 * `isAdmin` only decides what the page draws. What it's allowed to KNOW is
 * decided again on the server for every request — the API leaves the Swipe
 * figures out of the counter's response entirely.
 */
export default async function OpsLedgerPage() {
  if (!(await isOpsAuthed())) return <OpsLoginGate />;
  return (
    <>
      <OpsNav />
      <LedgerBoard isAdmin={await isAdminAuthed()} />
    </>
  );
}
