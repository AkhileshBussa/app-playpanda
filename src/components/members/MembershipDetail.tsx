"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import type { Membership, MembershipStatus, MembershipVisit } from "@/lib/members/types";
import { membershipStatus, playsLeft } from "@/lib/members/types";
import DeleteReasonSheet from "./DeleteReasonSheet";
import RecordVisitSheet from "./RecordVisitSheet";
import type { ApiMembership } from "./MembersApp";

interface MembershipDetailProps {
  membership: Membership;
  visits: MembershipVisit[];
  /** Today in IST, computed server-side so status matches the rest of the app. */
  today: string;
}

const STATUS_STYLE: Record<MembershipStatus, { label: string; className: string }> = {
  active: { label: "Active", className: "bg-green/15 text-green" },
  expired: { label: "Expired", className: "bg-coral/15 text-coral" },
  exhausted: { label: "Used up", className: "bg-ink/10 text-ink/50" },
  deleted: { label: "Deleted", className: "bg-ink/70 text-cream" },
};

const prettyDate = (d: string) =>
  new Date(`${d}T12:00:00+05:30`).toLocaleDateString("en-IN", {
    day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata",
  });

const dateTimeIST = (ms: number) =>
  new Date(ms).toLocaleString("en-IN", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
    hour12: true, timeZone: "Asia/Kolkata",
  });

/**
 * One membership in full: its terms, every punch ever made against it, and
 * the delete actions. Deletes are soft — rows stay, marked with a reason —
 * so the history of what happened is never lost.
 */
export default function MembershipDetail({ membership, visits, today }: MembershipDetailProps) {
  const router = useRouter();
  const [punching, setPunching] = useState(false);
  /** Which delete is being confirmed: the membership, or one punch. */
  const [confirming, setConfirming] = useState<{ kind: "membership" } | { kind: "punch"; visit: MembershipVisit } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const status = membershipStatus(membership, today);
  const left = playsLeft(membership);
  const isDeleted = membership.deletedAt != null;
  const livePunches = visits.filter((v) => v.deletedAt == null);

  const runDelete = async (reason: string) => {
    if (!confirming) return;
    setBusy(true);
    setError(null);
    try {
      const isMembership = confirming.kind === "membership";
      const res = await fetch(
        isMembership ? "/api/members/remove" : "/api/members/visit/remove",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            isMembership
              ? { membershipId: membership.id, reason }
              : { visitId: confirming.visit.id, reason }
          ),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        window.location.reload();
        return;
      }
      if (!res.ok) throw new Error(data.error || "Couldn't delete — please try again");

      setConfirming(null);
      setNotice(
        isMembership
          ? "Membership deleted. It stays here, marked as deleted."
          : `Punch deleted and its play${confirming.visit.playsUsed === 1 ? "" : "s"} given back.` +
            (confirming.visit.punchInvoiceNumber
              ? ` The ₹0 invoice ${confirming.visit.punchInvoiceNumber} is still in Swipe — remove it there if you need to.`
              : "")
      );
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete — please try again");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl">
      <Link href="/members" className="text-sm font-black text-teal underline underline-offset-2">
        ← Back
      </Link>

      {notice && (
        <p className="mt-3 rounded-2xl bg-teal/15 px-4 py-3 text-sm font-bold text-ink/80">
          {notice}
        </p>
      )}

      {/* Summary */}
      <section className="mt-3 rounded-chunk bg-white p-5 shadow-chunk">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-xl font-black text-ink">{membership.planName}</h2>
            <p className="text-sm font-bold text-ink/60">
              {membership.customerName} · {membership.phone}
              {membership.kidNames && ` · ${membership.kidNames}`}
            </p>
          </div>
          <span
            className={`shrink-0 rounded-full px-3 py-1 text-xs font-black uppercase tracking-wide ${STATUS_STYLE[status].className}`}
          >
            {STATUS_STYLE[status].label}
          </span>
        </div>

        {isDeleted && (
          <p className="mt-3 rounded-2xl bg-ink/5 px-3 py-2 text-sm font-bold text-ink/70">
            Deleted {dateTimeIST(membership.deletedAt!)}
            {membership.deletedReason && ` — ${membership.deletedReason}`}
          </p>
        )}

        <div className="mt-4">
          {membership.totalPlays == null ? (
            <p className="text-base font-black text-ink">
              Unlimited plays<span className="font-bold text-ink/50"> · once a day</span>
            </p>
          ) : (
            <>
              <div className="flex items-baseline justify-between">
                <p className="text-base font-black text-ink">
                  {left} of {membership.totalPlays} plays left
                </p>
                <p className="text-xs font-bold text-ink/50">{membership.playsUsed} used</p>
              </div>
              <div className="mt-1.5 h-2.5 overflow-hidden rounded-full bg-ink/10">
                <div
                  className="h-full rounded-full bg-teal transition-all"
                  style={{ width: `${Math.round(((left ?? 0) / membership.totalPlays) * 100)}%` }}
                />
              </div>
            </>
          )}
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5 text-xs font-black">
          <span className="rounded-full bg-cream px-2.5 py-1 text-ink/60">
            {membership.hoursPerPlay} hr{membership.hoursPerPlay === 1 ? "" : "s"}/play
          </span>
          {membership.kidsPerPlay > 1 && (
            <span className="rounded-full bg-cream px-2.5 py-1 text-ink/60">
              {membership.kidsPerPlay} kids/play
            </span>
          )}
          {membership.weekdaysOnly && (
            <span className="rounded-full bg-yellow/25 px-2.5 py-1 text-brown">Mon–Fri only</span>
          )}
          <span className="rounded-full bg-cream px-2.5 py-1 text-ink/60">
            {prettyDate(membership.startsOn)} → {prettyDate(membership.expiresOn)}
          </span>
          {membership.saleInvoiceNumber && (
            <span className="rounded-full bg-cream px-2.5 py-1 text-ink/60">
              Sale {membership.saleInvoiceNumber}
            </span>
          )}
        </div>

        {membership.notes && (
          <p className="mt-3 text-sm font-bold text-ink/50">{membership.notes}</p>
        )}

        {!isDeleted && (
          <button
            type="button"
            disabled={status !== "active"}
            onClick={() => setPunching(true)}
            className="mt-4 w-full rounded-full bg-teal py-3 text-base font-black text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed disabled:opacity-40 disabled:shadow-none sm:w-auto sm:px-8"
          >
            Punch a visit
          </button>
        )}
      </section>

      {/* Punches */}
      <section className="mt-4 rounded-chunk bg-white p-5 shadow-chunk">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-black uppercase tracking-widest text-coral">Punches</h3>
          <span className="text-xs font-black text-ink/50">
            {livePunches.length} counted
            {visits.length > livePunches.length && ` · ${visits.length - livePunches.length} deleted`}
          </span>
        </div>

        {visits.length === 0 ? (
          <p className="py-6 text-center text-sm font-bold text-ink/40">
            No visits punched against this membership yet.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-ink/5">
            {visits.map((v) => {
              const gone = v.deletedAt != null;
              return (
                <li key={v.id} className="flex items-start gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p
                      className={`text-base font-black ${gone ? "text-ink/35 line-through" : "text-ink"}`}
                    >
                      {dateTimeIST(v.visitedAt)}
                    </p>
                    <p className="text-xs font-bold text-ink/50">
                      {v.kidsCount} kid{v.kidsCount === 1 ? "" : "s"} · {v.playsUsed} play
                      {v.playsUsed === 1 ? "" : "s"}
                      {v.kidNames && ` · ${v.kidNames}`}
                      {v.punchInvoiceNumber && ` · ${v.punchInvoiceNumber}`}
                    </p>
                    {gone && (
                      <p className="mt-1 text-xs font-bold text-ink/40">
                        Deleted {dateTimeIST(v.deletedAt!)}
                        {v.deletedReason && ` — ${v.deletedReason}`}
                      </p>
                    )}
                  </div>
                  {!gone && !isDeleted && (
                    <button
                      type="button"
                      onClick={() => {
                        setError(null);
                        setConfirming({ kind: "punch", visit: v });
                      }}
                      className="shrink-0 rounded-full bg-cream px-3 py-1.5 text-xs font-black text-ink/60 transition-colors hover:bg-coral/15 hover:text-coral"
                    >
                      Delete
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Danger zone */}
      {!isDeleted && (
        <section className="mt-4 rounded-chunk border-2 border-dashed border-coral/40 bg-coral/5 p-5">
          <h3 className="text-sm font-black uppercase tracking-widest text-coral">
            Delete membership
          </h3>
          <p className="mt-1 text-sm font-bold text-ink/60">
            It stays in the ledger marked as deleted, with your reason. Punches already made
            are kept, and no Swipe invoices are touched.
          </p>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setConfirming({ kind: "membership" });
            }}
            className="mt-3 rounded-full bg-coral px-6 py-2.5 text-sm font-black text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed"
          >
            Delete this membership
          </button>
        </section>
      )}

      {punching && (
        <RecordVisitSheet
          open
          membership={{ ...membership, playsLeft: left, status, visits } as ApiMembership}
          onClose={() => setPunching(false)}
          onRecorded={(v) => {
            setPunching(false);
            setNotice(
              `Visit punched${v.punchInvoiceNumber ? ` — ${v.punchInvoiceNumber}` : ""}. Session is live on the monitor.`
            );
            router.refresh();
          }}
        />
      )}

      {confirming && (
        <DeleteReasonSheet
          title={confirming.kind === "membership" ? "Delete membership?" : "Delete this punch?"}
          subject={
            confirming.kind === "membership"
              ? `${membership.planName} · ${membership.customerName} · ${membership.phone}`
              : `${dateTimeIST(confirming.visit.visitedAt)} · ${confirming.visit.kidsCount} kid(s) · ${confirming.visit.playsUsed} play(s)`
          }
          consequence={
            confirming.kind === "membership"
              ? "Nothing is erased — it stays here as deleted and can't be punched again."
              : `The ${confirming.visit.playsUsed} ${confirming.visit.playsUsed === 1 ? "play goes" : "plays go"} back to the membership.` +
                (confirming.visit.punchInvoiceNumber
                  ? ` The ₹0 invoice ${confirming.visit.punchInvoiceNumber} stays in Swipe — delete it there separately.`
                  : "")
          }
          suggestions={
            confirming.kind === "membership"
              ? ["Created by mistake", "Wrong customer", "Refunded", "Duplicate entry"]
              : ["Punched by mistake", "Wrong membership", "Wrong number of kids", "Customer left"]
          }
          busy={busy}
          error={error}
          onCancel={() => {
            setConfirming(null);
            setError(null);
          }}
          onConfirm={runDelete}
        />
      )}
    </div>
  );
}
