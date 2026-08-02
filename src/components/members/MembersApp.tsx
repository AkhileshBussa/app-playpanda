"use client";

import { useCallback, useState } from "react";
import type { Membership, MembershipStatus, MembershipVisit } from "@/lib/members/types";
import { normalizePhone } from "@/lib/members/types";
import MembersTabs from "./MembersTabs";
import NewMembershipSheet from "./NewMembershipSheet";
import RecordVisitSheet from "./RecordVisitSheet";

/** Membership as the lookup API returns it — with computed status + visits. */
export interface ApiMembership extends Membership {
  playsLeft: number | null;
  status: MembershipStatus;
  visits: MembershipVisit[];
}

interface LookupResult {
  phone: string;
  customer: { name: string; kidNames: string[] } | null;
  memberships: ApiMembership[];
}

const inputClass =
  "w-full rounded-2xl border-2 border-ink/10 bg-cream/60 px-4 py-3.5 text-base font-bold text-ink outline-none placeholder:font-bold placeholder:text-ink/30 focus:border-coral";

const prettyDate = (d: string) =>
  new Date(`${d}T12:00:00+05:30`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });

const timeIST = (ms: number) =>
  new Date(ms).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });

const STATUS_STYLE: Record<MembershipStatus, { label: string; className: string }> = {
  active: { label: "Active", className: "bg-green/15 text-green" },
  expired: { label: "Expired", className: "bg-coral/15 text-coral" },
  exhausted: { label: "Used up", className: "bg-ink/10 text-ink/50" },
};

export default function MembersApp() {
  const [phone, setPhone] = useState("");
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [result, setResult] = useState<LookupResult | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [visitFor, setVisitFor] = useState<ApiMembership | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const lookup = useCallback(async (rawPhone: string): Promise<LookupResult | null> => {
    const p = normalizePhone(rawPhone);
    const res = await fetch(`/api/members/lookup?phone=${p}`, { cache: "no-store" });
    if (res.status === 401) {
      window.location.reload();
      return null;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Couldn't look that up — please try again");
    return data as LookupResult;
  }, []);

  const search = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const p = normalizePhone(phone);
    if (!/^\d{10}$/.test(p)) {
      setError("Enter a 10-digit phone number");
      return;
    }
    setSearching(true);
    setError(null);
    setNotice(null);
    try {
      const data = await lookup(p);
      if (data) setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't look that up — please try again");
    } finally {
      setSearching(false);
    }
  };

  /** Silent re-fetch after a create/punch so counts reconcile with the server. */
  const refresh = useCallback(async () => {
    if (!result) return;
    try {
      const data = await lookup(result.phone);
      if (data) setResult(data);
    } catch {
      // Transient — the optimistic update already shows the right state.
    }
  }, [result, lookup]);

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col px-5 pb-16 pt-6">
      {/* The nav already names the tool; keep the heading for screen readers. */}
      <header className="text-center">
        <h1 className="sr-only">Memberships</h1>
        <p className="text-sm font-bold text-ink/60">
          Look up a member, punch visits, add new members
        </p>
      </header>

      <div className="mt-3 flex justify-center">
        <MembersTabs />
      </div>

      {/* Search — capped so the input doesn't stretch across a wide screen. */}
      <form
        onSubmit={search}
        className="mx-auto mt-4 w-full rounded-chunk bg-white p-4 shadow-chunk lg:max-w-2xl"
      >
        <label className="mb-1 block px-1 text-sm font-bold uppercase tracking-widest text-ink/50">
          Member phone number
        </label>
        <div className="flex gap-2">
          <input
            type="tel"
            inputMode="numeric"
            value={phone}
            onChange={(e) => {
              setPhone(e.target.value);
              setError(null);
            }}
            placeholder="e.g. 9959060208"
            autoFocus
            className={`${inputClass} min-w-0 flex-1`}
          />
          <button
            type="submit"
            disabled={searching}
            className="shrink-0 rounded-full bg-coral px-6 text-base font-black text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed disabled:opacity-50"
          >
            {searching ? "…" : "Find"}
          </button>
        </div>
        {error && <p className="mt-2 px-1 text-sm font-bold text-coral">{error}</p>}
        {notice && (
          <p className="mt-2 rounded-2xl bg-teal/15 px-3 py-2 text-sm font-bold text-ink/80">{notice}</p>
        )}
      </form>

      {/* Results */}
      {result && (
        <div className="mt-5 flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-teal px-3 py-1 text-sm font-black text-cream">
              {result.memberships.length} membership{result.memberships.length === 1 ? "" : "s"}
            </span>
            {result.customer && (
              <span className="min-w-0 truncate text-sm font-bold text-ink/60">
                {result.customer.name}
                {result.customer.kidNames.length > 0 && ` · ${result.customer.kidNames.join(", ")}`}
              </span>
            )}
          </div>

          {result.memberships.length === 0 && (
            <p className="text-sm font-bold text-ink/40">
              No memberships on this number yet — add the first one below.
            </p>
          )}

          {/* Cards tile across the width on bigger screens; one per row on phones. */}
          <div className="grid items-start gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {result.memberships.map((m) => {
            const status = STATUS_STYLE[m.status];
            const pct =
              m.totalPlays == null ? 100 : Math.round(((m.playsLeft ?? 0) / m.totalPlays) * 100);
            const isOpen = expanded === m.id;
            return (
              <section key={m.id} className="rounded-chunk bg-white p-4 shadow-chunk">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="truncate text-lg font-black text-ink">{m.planName}</h2>
                    <p className="text-sm font-bold text-ink/60">
                      {m.customerName}
                      {m.kidNames && ` · ${m.kidNames}`}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-3 py-1 text-xs font-black uppercase tracking-wide ${status.className}`}
                  >
                    {status.label}
                  </span>
                </div>

                {/* Plays */}
                <div className="mt-3">
                  {m.totalPlays == null ? (
                    <p className="text-base font-black text-ink">
                      Unlimited plays
                      <span className="font-bold text-ink/50"> · once a day</span>
                    </p>
                  ) : (
                    <>
                      <div className="flex items-baseline justify-between">
                        <p className="text-base font-black text-ink">
                          {m.playsLeft} of {m.totalPlays} plays left
                        </p>
                        <p className="text-xs font-bold text-ink/50">{m.playsUsed} used</p>
                      </div>
                      <div className="mt-1.5 h-2.5 overflow-hidden rounded-full bg-ink/10">
                        <div
                          className="h-full rounded-full bg-teal transition-all"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </>
                  )}
                </div>

                {/* Facts */}
                <div className="mt-3 flex flex-wrap gap-1.5 text-xs font-black">
                  <span className="rounded-full bg-cream px-2.5 py-1 text-ink/60">
                    {m.hoursPerPlay} hr{m.hoursPerPlay === 1 ? "" : "s"}/play
                  </span>
                  {m.kidsPerPlay > 1 && (
                    <span className="rounded-full bg-cream px-2.5 py-1 text-ink/60">
                      {m.kidsPerPlay} kids/play
                    </span>
                  )}
                  {m.weekdaysOnly && (
                    <span className="rounded-full bg-yellow/25 px-2.5 py-1 text-brown">Mon–Fri only</span>
                  )}
                  <span
                    className={`rounded-full px-2.5 py-1 ${
                      m.status === "expired" ? "bg-coral/15 text-coral" : "bg-cream text-ink/60"
                    }`}
                  >
                    {m.status === "expired" ? "Expired" : "Expires"} {prettyDate(m.expiresOn)}
                  </span>
                </div>

                {/* Actions */}
                <div className="mt-4 flex items-center gap-2">
                  <button
                    type="button"
                    disabled={m.status !== "active"}
                    onClick={() => setVisitFor(m)}
                    className="flex-1 rounded-full bg-teal py-3 text-base font-black text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed disabled:opacity-40 disabled:shadow-none"
                  >
                    Punch a visit
                  </button>
                  <button
                    type="button"
                    onClick={() => setExpanded(isOpen ? null : m.id)}
                    className="shrink-0 rounded-full bg-cream px-4 py-3 text-sm font-black text-ink/60 transition-all active:translate-y-0.5"
                  >
                    {isOpen ? "Hide" : `Visits (${m.visits.length})`}
                  </button>
                </div>

                {/* Visit history */}
                {isOpen && (
                  <ul className="mt-3 divide-y divide-ink/5 border-t border-ink/5">
                    {m.visits.length === 0 && (
                      <li className="py-2.5 text-center text-sm font-bold text-ink/40">
                        No visits punched yet.
                      </li>
                    )}
                    {m.visits.map((v) => (
                      <li key={v.id} className="flex items-center gap-3 py-2.5">
                        <span className="min-w-0 flex-1 text-sm font-black text-ink">
                          {timeIST(v.visitedAt)}
                          {v.kidNames && (
                            <span className="block truncate text-xs font-bold text-ink/50">
                              {v.kidNames}
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 text-xs font-bold text-ink/50">
                          {v.kidsCount} kid{v.kidsCount === 1 ? "" : "s"} · {v.playsUsed} play
                          {v.playsUsed === 1 ? "" : "s"}
                        </span>
                        {v.punchInvoiceNumber && (
                          <span className="shrink-0 rounded-full bg-cream px-2 py-0.5 text-[11px] font-black text-ink/50">
                            {v.punchInvoiceNumber}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}

          {/* Sits in the grid as an "empty slot" tile next to the real cards. */}
          <button
            type="button"
            onClick={() => setShowNew(true)}
            className="rounded-chunk border-2 border-dashed border-teal/50 bg-teal/5 px-4 py-3.5 text-base font-black text-teal transition-all active:translate-y-0.5 sm:min-h-[11rem]"
          >
            + New membership on this number
          </button>
          </div>
        </div>
      )}

      {!result && (
        <p className="mt-8 text-center text-sm font-bold text-ink/40">
          Search a phone number to see their memberships and visits.
        </p>
      )}

      {/* Sheets */}
      <NewMembershipSheet
        open={showNew}
        onClose={() => setShowNew(false)}
        initialPhone={result?.phone ?? normalizePhone(phone)}
        initialName={result?.customer?.name ?? ""}
        initialKids={result?.customer?.kidNames.join(", ") ?? ""}
        onCreated={(m) => {
          setShowNew(false);
          setNotice(`${m.planName} added for ${m.customerName} — expires ${prettyDate(m.expiresOn)}.`);
          refresh();
        }}
      />
      {visitFor && (
        <RecordVisitSheet
          open
          membership={visitFor}
          onClose={() => setVisitFor(null)}
          onRecorded={(v) => {
            setVisitFor(null);
            setNotice(
              `Visit punched${v.punchInvoiceNumber ? ` — ${v.punchInvoiceNumber}` : ""}. Session is live on the monitor.`
            );
            refresh();
          }}
        />
      )}
    </main>
  );
}
