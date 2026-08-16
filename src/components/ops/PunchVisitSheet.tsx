"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import RecordVisitSheet from "@/components/members/RecordVisitSheet";
import type { ApiMembership } from "@/components/members/MembersApp";
import { normalizePhone, type MembershipStatus } from "@/lib/members/types";

interface PunchVisitSheetProps {
  onClose: () => void;
  /** A visit was punched — its ₹0 invoice is in Swipe, so refresh the board. */
  onPunched: () => void;
}

const prettyDate = (d: string) =>
  new Date(`${d}T12:00:00+05:30`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    timeZone: "Asia/Kolkata",
  });

const STATUS_LABEL: Record<MembershipStatus, { label: string; className: string }> = {
  active: { label: "Active", className: "bg-teal text-cream" },
  exhausted: { label: "No plays left", className: "bg-ink/10 text-ink/50" },
  expired: { label: "Expired", className: "bg-coral/15 text-coral" },
  deleted: { label: "Removed", className: "bg-ink/10 text-ink/50" },
};

/**
 * Punch a membership visit from the session monitor.
 *
 * This is the /members "Punch a visit" flow, not a copy of it: the phone lookup
 * hits the same /api/members/lookup and the confirm step IS the same
 * RecordVisitSheet component, so plays are deducted atomically in Postgres and
 * the ₹0 punch invoice is created in Swipe exactly as it is from the
 * memberships screen — including the weekday-only warning and the
 * not-enough-plays guard. It exists here purely to save the walk to /members
 * and back while a member's kid is standing at the desk.
 */
export default function PunchVisitSheet({ onClose, onPunched }: PunchVisitSheetProps) {
  const [phone, setPhone] = useState("");
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [memberships, setMemberships] = useState<ApiMembership[]>([]);
  const [customerName, setCustomerName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [punchFor, setPunchFor] = useState<ApiMembership | null>(null);
  const phoneRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    phoneRef.current?.focus();
  }, []);

  const digits = normalizePhone(phone);

  useEffect(() => {
    if (digits.length !== 10) {
      setSearched(false);
      setMemberships([]);
      setError(null);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/members/lookup?phone=${digits}`, { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.status === 401) {
          window.location.reload();
          return;
        }
        if (!res.ok) throw new Error(data.error || "Couldn't look that up");
        const found = (data.memberships ?? []) as ApiMembership[];
        setMemberships(found);
        setCustomerName(data.customer?.name ?? found[0]?.customerName ?? "");
        setError(null);
        // One punchable pass is the normal case — go straight to the confirm
        // step rather than making someone pick from a list of one.
        const punchable = found.filter((m) => m.status === "active");
        if (punchable.length === 1) setPunchFor(punchable[0]);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Couldn't look that up");
      } finally {
        if (!cancelled) {
          setSearching(false);
          setSearched(true);
        }
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [digits]);

  // The confirm step owns the screen once a membership is chosen.
  if (punchFor) {
    return (
      <RecordVisitSheet
        open
        membership={punchFor}
        onClose={() => setPunchFor(null)}
        onRecorded={() => {
          setPunchFor(null);
          onPunched();
          onClose();
        }}
      />
    );
  }

  const punchable = memberships.filter((m) => m.status === "active");

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-ink/40" onClick={onClose} />

      <div className="relative mx-4 w-full max-w-md rounded-t-chunk bg-cream p-6 shadow-chunk sm:rounded-chunk">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-xl font-black text-ink">Membership visit</h2>
          <button
            onClick={onClose}
            className="text-2xl leading-none text-ink/40 hover:text-ink"
            aria-label="Close"
          >
            &times;
          </button>
        </div>
        <p className="mb-4 text-sm font-bold text-ink/60">
          Look up the member, then punch the visit — same as on the memberships screen.
        </p>

        <label
          htmlFor="punch-phone"
          className="mb-1 block px-1 text-sm font-bold uppercase tracking-widest text-ink/50"
        >
          Member&apos;s mobile
        </label>
        <input
          id="punch-phone"
          ref={phoneRef}
          type="tel"
          inputMode="numeric"
          value={phone}
          onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 10))}
          placeholder="10 digits"
          className="w-full rounded-2xl border-2 border-ink/10 bg-white px-4 py-3 text-base font-bold tracking-wide text-ink outline-none placeholder:font-bold placeholder:tracking-normal placeholder:text-ink/30 focus:border-coral"
        />

        {error && <p className="mt-3 px-1 text-sm font-bold text-coral">{error}</p>}

        {searching && (
          <p className="mt-4 px-1 text-sm font-bold text-ink/40">Looking up…</p>
        )}

        {!searching && searched && memberships.length === 0 && (
          <div className="mt-4 rounded-2xl bg-white px-4 py-3">
            <p className="text-sm font-black text-ink">No membership on this number</p>
            <p className="mt-0.5 text-sm font-bold text-ink/50">
              Bill the pass in Swipe first, then record it.
            </p>
            <Link
              href="/members/new"
              className="mt-2 inline-block rounded-full bg-ink px-4 py-2 text-sm font-black text-cream"
            >
              Sell a membership →
            </Link>
          </div>
        )}

        {!searching && memberships.length > 0 && (
          <div className="mt-4">
            {customerName && (
              <p className="mb-1.5 px-1 text-sm font-black text-ink">{customerName}</p>
            )}
            <div className="space-y-1.5">
              {memberships.map((m) => {
                const status = STATUS_LABEL[m.status];
                const canPunch = m.status === "active";
                return (
                  <button
                    key={m.id}
                    type="button"
                    disabled={!canPunch}
                    onClick={() => setPunchFor(m)}
                    className={`flex w-full items-center justify-between gap-3 rounded-2xl px-4 py-3 text-left transition-colors ${
                      canPunch ? "bg-white hover:bg-ink/5" : "bg-white/50"
                    }`}
                  >
                    <div className="min-w-0">
                      <p
                        className={`truncate text-sm font-black ${canPunch ? "text-ink" : "text-ink/40"}`}
                      >
                        {m.planName}
                      </p>
                      <p className="text-xs font-bold text-ink/50">
                        {m.playsLeft == null
                          ? "Unlimited · once a day"
                          : `${m.playsLeft} of ${m.totalPlays} plays left`}
                        {" · "}
                        {prettyDate(m.expiresOn)}
                      </p>
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-black uppercase tracking-wide ${status.className}`}
                    >
                      {status.label}
                    </span>
                  </button>
                );
              })}
            </div>
            {punchable.length === 0 && (
              <p className="mt-2 px-1 text-xs font-bold text-ink/50">
                Nothing punchable on this number — a renewal has to be sold and recorded first.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
