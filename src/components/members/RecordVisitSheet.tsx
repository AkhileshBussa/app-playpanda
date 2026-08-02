"use client";

import { useRef, useState } from "react";
import type { MembershipVisit } from "@/lib/members/types";
import { playsForKids } from "@/lib/members/types";
import type { ApiMembership } from "./MembersApp";

interface RecordVisitSheetProps {
  open: boolean;
  membership: ApiMembership;
  onClose: () => void;
  onRecorded: (visit: MembershipVisit, membership: ApiMembership) => void;
}

const inputClass =
  "w-full rounded-2xl border-2 border-ink/10 bg-cream/60 px-4 py-3 text-base font-bold text-ink outline-none placeholder:font-bold placeholder:text-ink/30 focus:border-coral";

const prettyDate = (d: string) =>
  new Date(`${d}T12:00:00+05:30`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });

/**
 * Punch one visit against a membership: pick how many kids are going in,
 * see exactly how many plays that uses, confirm. The server deducts plays
 * atomically and creates the ₹0 punch invoice in Swipe.
 */
export default function RecordVisitSheet({
  open,
  membership,
  onClose,
  onRecorded,
}: RecordVisitSheetProps) {
  const [kids, setKids] = useState(1);
  const [kidNames, setKidNames] = useState(membership.kidNames);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Armed after the weekday-only warning; the next submit forces.
  const forceArmed = useRef(false);

  if (!open) return null;

  const playsUsed = playsForKids(kids, membership.kidsPerPlay);
  const leftAfter =
    membership.playsLeft == null ? null : membership.playsLeft - playsUsed;
  const overdrawn = leftAfter != null && leftAfter < 0;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving || overdrawn) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/members/visit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          membershipId: membership.id,
          kidsCount: kids,
          kidNames: kidNames.trim(),
          force: forceArmed.current,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        window.location.reload();
        return;
      }
      if (res.status === 409 && data.warning && data.code === "weekend") {
        forceArmed.current = true;
        setNotice(data.error);
        return;
      }
      if (!res.ok || !data.visit) {
        throw new Error(data.error || "Couldn't punch the visit — please try again");
      }
      onRecorded(data.visit as MembershipVisit, data.membership as ApiMembership);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't punch the visit — please try again");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-ink/40" onClick={onClose} />

      <div className="relative mx-4 w-full max-w-md rounded-t-chunk bg-cream p-6 shadow-chunk sm:rounded-chunk">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-xl font-black text-ink">Punch a visit</h2>
          <button
            onClick={onClose}
            className="text-2xl leading-none text-ink/40 hover:text-ink"
            aria-label="Close"
          >
            &times;
          </button>
        </div>
        {/* Two memberships can share a plan name (a renewal on top of an
            unfinished pass), so spell out which one this is before punching. */}
        <p className="text-sm font-bold text-ink/60">
          {membership.planName} · {membership.customerName}
        </p>
        <p className="mb-5 text-sm font-black text-ink/70">
          {membership.playsLeft == null
            ? "Unlimited · once a day"
            : `${membership.playsLeft} of ${membership.totalPlays} plays left`}
          {" · expires "}
          {prettyDate(membership.expiresOn)}
        </p>

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="mb-1 block px-1 text-sm font-bold uppercase tracking-widest text-ink/50">
              Kids going in
            </label>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setKids((k) => Math.max(1, k - 1))}
                className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-white text-xl font-black text-ink shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed"
                aria-label="Fewer kids"
              >
                −
              </button>
              <span className="w-10 text-center text-2xl font-black tabular-nums text-ink">{kids}</span>
              <button
                type="button"
                onClick={() => setKids((k) => Math.min(10, k + 1))}
                className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-white text-xl font-black text-ink shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed"
                aria-label="More kids"
              >
                +
              </button>
              <span className="min-w-0 flex-1 text-sm font-bold text-ink/60">
                uses {playsUsed} play{playsUsed === 1 ? "" : "s"}
                {leftAfter != null && !overdrawn && ` → ${leftAfter} left`}
              </span>
            </div>
          </div>

          <div>
            <label className="mb-1 block px-1 text-sm font-bold uppercase tracking-widest text-ink/50">
              Kid names (optional)
            </label>
            <input
              type="text"
              value={kidNames}
              onChange={(e) => setKidNames(e.target.value)}
              placeholder="e.g. Nihira, Advik"
              className={inputClass}
            />
          </div>

          {overdrawn && (
            <p className="rounded-2xl bg-coral/10 px-3 py-2 text-sm font-bold text-coral">
              Only {membership.playsLeft} play{membership.playsLeft === 1 ? "" : "s"} left on this
              membership — not enough for {kids} kid{kids === 1 ? "" : "s"}.
            </p>
          )}
          {notice && (
            <p className="rounded-2xl bg-yellow/25 px-3 py-2 text-sm font-bold text-ink/80">{notice}</p>
          )}
          {error && <p className="px-1 text-sm font-bold text-coral">{error}</p>}

          <button
            type="submit"
            disabled={saving || overdrawn}
            className="w-full rounded-full bg-teal py-3.5 text-base font-black text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed disabled:opacity-50"
          >
            {saving ? "Punching…" : `Punch ${playsUsed} play${playsUsed === 1 ? "" : "s"}`}
          </button>
        </form>
      </div>
    </div>
  );
}
