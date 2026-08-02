"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { computeOpsStatus, type OpsSession, type OpsStatus } from "@/lib/ops/types";
import { getManualVisits, manualToOpsSession, type ManualVisit } from "@/lib/ops/manual";
import OpsSessionCard from "./OpsSessionCard";
import AddVisit from "./AddVisit";
import InvoiceItemsSheet from "./InvoiceItemsSheet";
import SalesLine from "./SalesLine";

type Filter = "all" | OpsStatus;

/** Optimistic check-in/out state applied over server data until the next poll. */
type Override = { checkinAt?: number | null; checkoutAt?: number | null };

const POLL_MS = 30_000;

export default function OpsDashboard() {
  const [apiSessions, setApiSessions] = useState<OpsSession[]>([]);
  const [checkouts, setCheckouts] = useState<Record<string, number>>({});
  const [manualVisits, setManualVisits] = useState<ManualVisit[]>([]);
  const [overrides, setOverrides] = useState<Record<string, Override>>({});
  const [filter, setFilter] = useState<Filter>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  /** Session whose invoice items are being viewed. */
  const [invoiceFor, setInvoiceFor] = useState<OpsSession | null>(null);
  const [now, setNow] = useState(Date.now());

  // Actions in flight — while >0, keep optimistic overrides through polls.
  const pendingActions = useRef(0);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/ops/sessions");
      const data = await res.json();
      if (res.status === 401 && !data.needsSetup) {
        // Ops cookie expired — reload to land on the login gate.
        window.location.reload();
        return;
      }
      if (data.needsSetup) {
        setNeedsSetup(true);
        setError(data.error);
        return;
      }
      if (!res.ok) throw new Error(data.error || "Failed to fetch");
      setNeedsSetup(false);
      setApiSessions(data.sessions);
      setCheckouts(data.checkouts ?? {});
      if (pendingActions.current === 0) setOverrides({});
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load sessions. Retrying…");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setManualVisits(getManualVisits());
    fetchSessions();
    const poll = setInterval(fetchSessions, POLL_MS);
    // Coarse re-render tick so filters/counts track status flips between polls
    // (each card runs its own 1s countdown).
    const tick = setInterval(() => setNow(Date.now()), 10_000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [fetchSessions]);

  /** Run a check-in/out mutation with an optimistic override + resync. */
  const mutate = useCallback(
    async (id: string, override: Override, request: () => Promise<Response>) => {
      pendingActions.current++;
      setOverrides((prev) => ({ ...prev, [id]: { ...prev[id], ...override } }));
      try {
        const res = await request();
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          return data?.error || "Something went wrong";
        }
        return null;
      } catch {
        return "Network error — please retry";
      } finally {
        pendingActions.current--;
        fetchSessions();
      }
    },
    [fetchSessions]
  );

  const handleCheckIn = useCallback(
    async (session: OpsSession, code: string): Promise<string | null> => {
      // No optimistic flip before the code is verified — apply on success only.
      pendingActions.current++;
      try {
        const res = await fetch("/api/ops/checkin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: session.id, invoiceNumber: session.invoiceNumber, code }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return data?.error || "Check-in failed";
        setOverrides((prev) => ({
          ...prev,
          [session.id]: { ...prev[session.id], checkinAt: data.checkinAt ?? Date.now() },
        }));
        return null;
      } catch {
        return "Network error — please retry";
      } finally {
        pendingActions.current--;
        fetchSessions();
      }
    },
    [fetchSessions]
  );

  const handleUndoCheckIn = useCallback(
    (session: OpsSession) => {
      mutate(session.id, { checkinAt: null }, () =>
        fetch("/api/ops/checkin", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: session.id }),
        })
      );
    },
    [mutate]
  );

  const handleCheckout = useCallback(
    (session: OpsSession, undo: boolean) => {
      mutate(session.id, { checkoutAt: undo ? null : Date.now() }, () =>
        fetch("/api/ops/checkout", {
          method: undo ? "DELETE" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: session.id }),
        })
      );
    },
    [mutate]
  );

  // Merge API + manual sessions, apply optimistic overrides.
  const allSessions = [
    ...apiSessions,
    ...manualVisits.map((v) => manualToOpsSession(v, checkouts)),
  ].map((s) => {
    const ov = overrides[s.id];
    return ov ? { ...s, ...ov } : s;
  });

  const withStatus = allSessions.map((s) => ({ session: s, status: computeOpsStatus(s, now) }));

  const order: Record<OpsStatus, number> = {
    waiting: 0,
    active: 1,
    expiring: 2,
    expired: 3,
    checked_out: 4,
  };
  const sorted = [...withStatus].sort((a, b) => order[a.status] - order[b.status]);
  const filtered = filter === "all" ? sorted : sorted.filter((s) => s.status === filter);

  const counts = withStatus.reduce(
    (acc, s) => {
      acc[s.status]++;
      return acc;
    },
    { waiting: 0, active: 0, expiring: 0, expired: 0, checked_out: 0 } as Record<OpsStatus, number>
  );
  // Kids physically inside: exclude not-yet-arrived (waiting) and left.
  const kidsInside = withStatus
    .filter((s) => s.status !== "waiting" && s.status !== "checked_out")
    .reduce((n, s) => n + s.session.kidCount, 0);

  const filters: { key: Filter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "waiting", label: "Waiting" },
    { key: "active", label: "Active" },
    { key: "expiring", label: "Expiring" },
    { key: "expired", label: "Expired" },
    { key: "checked_out", label: "Left" },
  ];

  return (
    <div className="min-h-dvh">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b-2 border-ink/5 bg-cream/95 backdrop-blur">
        <div className="flex flex-col items-center px-4 py-3">
          {/* The nav already names the tool; keep the heading for screen readers. */}
          <h1 className="sr-only">Session Monitor</h1>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <StatBadge label="Waiting" count={counts.waiting} className="bg-purple/15 text-purple" />
            <StatBadge label="Active" count={counts.active} className="bg-green/15 text-green" />
            <StatBadge label="Expiring" count={counts.expiring} className="bg-yellow/25 text-brown" />
            <StatBadge label="Expired" count={counts.expired} className="bg-coral/15 text-coral" />
            <span className="whitespace-nowrap rounded-full bg-ink px-3.5 py-1 text-sm font-black text-cream">
              {kidsInside} <span className="font-bold opacity-70">inside</span>
            </span>
          </div>
          <div className="mt-2">
            <SalesLine />
          </div>
        </div>
      </header>

      <div className="px-3 py-3">
        {/* Filter tabs */}
        <div className="mb-3 flex gap-1.5 overflow-x-auto pb-1">
          {filters.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`whitespace-nowrap rounded-full px-4 py-2 text-sm font-black transition-colors ${
                filter === f.key ? "bg-ink text-cream" : "bg-white text-ink/60 hover:bg-ink/10"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* Content */}
        {loading ? (
          <div className="py-20 text-center">
            <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-ink/15 border-t-coral" />
            <p className="mt-4 text-base font-bold text-ink/50">Loading today&apos;s sessions…</p>
          </div>
        ) : needsSetup ? (
          <div className="py-20 text-center">
            <p className="mb-3 text-5xl">🔑</p>
            <p className="text-lg font-black text-ink">Swipe token needed</p>
            <p className="mx-auto mt-1 max-w-sm text-base font-bold text-ink/50">
              {error || "The Swipe session token is missing or expired."} Refresh it from
              pp-billing → Settings.
            </p>
          </div>
        ) : error ? (
          <div className="py-20 text-center">
            <p className="text-base font-bold text-coral">{error}</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-20 text-center">
            <Image
              src="/MascotWithoutBG.png"
              alt=""
              width={96}
              height={128}
              className="mx-auto mb-4 h-32 w-auto"
            />
            <p className="text-lg font-black text-ink/60">
              {filter === "all"
                ? "No sessions today yet"
                : `No ${filter === "checked_out" ? "checked-out" : filter} sessions`}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2 pb-24 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {filtered.map(({ session }) => (
              <OpsSessionCard
                key={session.id}
                session={session}
                onCheckIn={handleCheckIn}
                onUndoCheckIn={handleUndoCheckIn}
                onCheckout={handleCheckout}
                onShowInvoice={setInvoiceFor}
              />
            ))}
          </div>
        )}
      </div>

      {/* Floating add button — manual membership visit */}
      <button
        onClick={() => setShowAddForm(true)}
        className="fixed bottom-6 right-6 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-coral text-3xl leading-none text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed"
        title="Add membership visit"
      >
        +
      </button>

      {invoiceFor && (
        <InvoiceItemsSheet session={invoiceFor} onClose={() => setInvoiceFor(null)} />
      )}

      <AddVisit
        open={showAddForm}
        onClose={() => setShowAddForm(false)}
        onAdded={() => setManualVisits(getManualVisits())}
      />
    </div>
  );
}

function StatBadge({
  label,
  count,
  className,
}: {
  label: string;
  count: number;
  className: string;
}) {
  return (
    <span className={`whitespace-nowrap rounded-full px-3.5 py-1 text-sm font-black ${className}`}>
      {count} {label}
    </span>
  );
}
