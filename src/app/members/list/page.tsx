import type { Metadata } from "next";
import Link from "next/link";
import { isOpsAuthed } from "@/lib/ops/auth";
import { todayIST } from "@/lib/ops/state";
import { listAllMemberships, membersDbConfigured } from "@/lib/members/db";
import { membershipStatus, playsLeft, type Membership, type MembershipStatus } from "@/lib/members/types";
import OpsLoginGate from "@/components/ops/OpsLoginGate";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Play Panda — All Members",
  robots: { index: false, follow: false },
};

const prettyDate = (d: string) =>
  new Date(`${d}T12:00:00+05:30`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });

const STATUS_STYLE: Record<MembershipStatus, { label: string; className: string }> = {
  active: { label: "Active", className: "bg-green/15 text-green" },
  expired: { label: "Expired", className: "bg-coral/15 text-coral" },
  exhausted: { label: "Used up", className: "bg-ink/10 text-ink/50" },
};

/** The full membership ledger — every member, plays left, expiry. CSV export. */
export default async function MembersListPage() {
  if (!(await isOpsAuthed())) return <OpsLoginGate />;

  let memberships: Membership[] = [];
  let loadError: string | null = null;
  if (!membersDbConfigured()) {
    loadError = "Membership database not set up yet — set DATABASE_URL (see docs/memberships.md).";
  } else {
    try {
      memberships = await listAllMemberships();
    } catch (err) {
      console.error("failed to load members ledger:", err);
      loadError = "Couldn't load the ledger — please refresh.";
    }
  }

  const today = todayIST();
  const withStatus = memberships.map((m) => ({ ...m, status: membershipStatus(m, today) }));
  const activeCount = withStatus.filter((m) => m.status === "active").length;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 pb-16 pt-6">
      <header>
        <h1 className="text-2xl font-black leading-tight text-ink">All members</h1>
        <p className="mt-1 text-sm font-bold text-ink/60">
          Every membership, newest first · plays left & expiry
        </p>
      </header>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Link href="/members" className="text-sm font-black text-teal underline underline-offset-2">
          ← Member lookup
        </Link>
        <span className="flex-1" />
        <a
          href="/api/members/export?what=memberships"
          className="rounded-full bg-white px-3.5 py-1.5 text-xs font-black text-ink/70 shadow-[0_2px_0_rgba(0,0,0,0.06)]"
        >
          ⬇ Members CSV
        </a>
        <a
          href="/api/members/export?what=visits"
          className="rounded-full bg-white px-3.5 py-1.5 text-xs font-black text-ink/70 shadow-[0_2px_0_rgba(0,0,0,0.06)]"
        >
          ⬇ Visits CSV
        </a>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-teal px-3 py-1 text-sm font-black text-cream">
          {withStatus.length} member{withStatus.length === 1 ? "" : "s"}
        </span>
        <span className="rounded-full bg-green/15 px-3 py-1 text-sm font-black text-green">
          {activeCount} active
        </span>
      </div>

      {loadError ? (
        <p className="mt-8 text-center text-sm font-bold text-coral">{loadError}</p>
      ) : withStatus.length === 0 ? (
        <p className="mt-8 text-center text-sm font-bold text-ink/40">
          No memberships recorded yet — add the first one from the member lookup page.
        </p>
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {withStatus.map((m) => {
            const status = STATUS_STYLE[m.status];
            const left = playsLeft(m);
            return (
              <li key={m.id} className="rounded-chunk bg-white p-4 shadow-chunk">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-base font-black text-ink">{m.customerName}</p>
                    <p className="text-sm font-bold text-ink/60">
                      {m.phone} · {m.planName}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-3 py-1 text-xs font-black uppercase tracking-wide ${status.className}`}
                  >
                    {status.label}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5 text-xs font-black text-ink/60">
                  <span className="rounded-full bg-cream px-2.5 py-1">
                    {left == null ? "Unlimited · 1/day" : `${left} of ${m.totalPlays} plays left`}
                  </span>
                  <span className="rounded-full bg-cream px-2.5 py-1">
                    {m.status === "expired" ? "Expired" : "Expires"} {prettyDate(m.expiresOn)}
                  </span>
                  {m.saleInvoiceNumber && (
                    <span className="rounded-full bg-cream px-2.5 py-1">{m.saleInvoiceNumber}</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
