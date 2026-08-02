import type { Metadata } from "next";
import { isOpsAuthed } from "@/lib/ops/auth";
import OpsLoginGate from "@/components/ops/OpsLoginGate";
import OpsNav from "@/components/ops/OpsNav";
import MembersTabs from "@/components/members/MembersTabs";
import MembershipForm from "@/components/members/MembershipForm";
import { normalizePhone } from "@/lib/members/types";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Play Panda — New Membership",
  robots: { index: false, follow: false },
};

/**
 * Record a membership the customer just bought. Independent of the counter —
 * no lookup needed first. `?phone=` prefills when arriving from a lookup.
 */
export default async function NewMembershipPage({
  searchParams,
}: {
  searchParams: Promise<{ phone?: string }>;
}) {
  if (!(await isOpsAuthed())) return <OpsLoginGate />;

  const { phone } = await searchParams;
  const initialPhone = phone ? normalizePhone(phone) : "";

  return (
    <>
      <OpsNav />
      <main className="mx-auto flex w-full max-w-6xl flex-col px-5 pb-16 pt-6">
        <header className="text-center">
          <h1 className="sr-only">New membership</h1>
          <p className="text-sm font-bold text-ink/60">
            Bill the sale in Swipe as usual — this records it for visit tracking
          </p>
        </header>

        <div className="mt-3 flex justify-center">
          <MembersTabs />
        </div>

        <div className="mt-4">
          <MembershipForm initialPhone={initialPhone} />
        </div>
      </main>
    </>
  );
}
