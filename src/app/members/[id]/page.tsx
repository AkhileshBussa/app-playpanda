import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isOpsAuthed } from "@/lib/ops/auth";
import { todayIST } from "@/lib/ops/state";
import { getMembership, listVisits, membersDbConfigured } from "@/lib/members/db";
import OpsLoginGate from "@/components/ops/OpsLoginGate";
import OpsNav from "@/components/ops/OpsNav";
import MembersTabs from "@/components/members/MembersTabs";
import MembershipDetail from "@/components/members/MembershipDetail";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Play Panda — Membership",
  robots: { index: false, follow: false },
};

/** One membership: its terms, every punch against it, and the delete actions. */
export default async function MembershipPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!(await isOpsAuthed())) return <OpsLoginGate />;

  const { id } = await params;

  if (!membersDbConfigured()) {
    return (
      <>
        <OpsNav />
        <main className="mx-auto w-full max-w-3xl px-5 pb-16 pt-6">
          <p className="text-center text-sm font-bold text-coral">
            Membership database not set up yet — set DATABASE_URL (see docs/memberships.md).
          </p>
        </main>
      </>
    );
  }

  const membership = await getMembership(id);
  if (!membership) notFound();
  const visits = await listVisits(id);

  return (
    <>
      <OpsNav />
      <main className="mx-auto flex w-full max-w-6xl flex-col px-5 pb-16 pt-6">
        <header className="text-center">
          <h1 className="sr-only">
            {membership.planName} — {membership.customerName}
          </h1>
          <p className="text-sm font-bold text-ink/60">
            Membership details, punches and deletions
          </p>
        </header>

        <div className="mt-3 flex justify-center">
          <MembersTabs />
        </div>

        <div className="mt-4">
          <MembershipDetail membership={membership} visits={visits} today={todayIST()} />
        </div>
      </main>
    </>
  );
}
