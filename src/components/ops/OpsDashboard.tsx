"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { computeOpsStatus, opsEndTime, type OpsSession, type OpsStatus } from "@/lib/ops/types";
import { BAND_SLOTS, isBandWindow } from "@/lib/ops/bands";
import { getManualVisits, manualToOpsSession, type ManualVisit } from "@/lib/ops/manual";
import OpsSessionCard from "./OpsSessionCard";
import AttendanceAlert from "./AttendanceAlert";
import AddVisit from "./AddVisit";
import InvoiceItemsSheet from "./InvoiceItemsSheet";
import CollectPaymentSheet from "./CollectPaymentSheet";
import SalesLine from "./SalesLine";

type Filter = "all" | OpsStatus;

/** Optimistic check-in/out state applied over server data until the next poll. */
type Override = { checkinAt?: number | null; checkoutAt?: number | null };

const POLL_MS = 30_000;

/**
 * The weekend evening rush is the one stretch where two tablets are checking
 * people in at once, so a 30s-stale board actively misleads the counter. The
 * poll tightens to 5s then and drops straight back afterwards.
 *
 * Deliberately narrow: one poll costs a Swipe call per invoice raised today, so
 * this cadence would be far too expensive to run all day. Weekend days as
 * `Date#getDay` numbers them, on the tablet's own clock (IST).
 */
const RUSH_DAYS = [0, 6];
const RUSH_FROM_HOUR = 17;
const RUSH_TO_HOUR = 21;
const RUSH_POLL_MS = 5_000;

/** Ms until this session's time is up; null when no clock is running — untimed
 *  membership visits, and bookings still waiting to check in. */
function remainingMs(s: OpsSession, now: number): number | null {
  const end = opsEndTime(s);
  return end == null ? null : end - now;
}

function pollDelay(at = new Date()): number {
  const inRush =
    RUSH_DAYS.includes(at.getDay()) &&
    at.getHours() >= RUSH_FROM_HOUR &&
    at.getHours() < RUSH_TO_HOUR;
  return inRush ? RUSH_POLL_MS : POLL_MS;
}

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
  /** Session we're taking payment for. */
  const [collectFor, setCollectFor] = useState<OpsSession | null>(null);
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

    // Self-scheduling instead of setInterval, for two reasons that both matter
    // at 5s: the delay is re-decided every cycle, so a board left open on a
    // Saturday speeds up at 5pm and slows down at 9pm on its own; and the next
    // poll is only queued once the previous one lands, so a slow Swipe can't
    // leave requests stacking up behind each other.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const schedule = () => {
      if (stopped) return;
      timer = setTimeout(async () => {
        // A monitor left open on a background tab shouldn't keep hitting Swipe.
        if (!document.hidden) await fetchSessions();
        schedule();
      }, pollDelay());
    };
    schedule();

    // …but catch up the moment it's looked at again.
    const onVisibility = () => {
      if (!document.hidden) fetchSessions();
    };
    document.addEventListener("visibilitychange", onVisibility);

    // Coarse re-render tick so filters/counts track status flips between polls
    // (each card runs its own 1s countdown).
    const tick = setInterval(() => setNow(Date.now()), 10_000);
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisibility);
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
        // Check-in is when the customer is at the counter, so if they still owe
        // money, put the payment in front of the manager rather than waiting
        // for them to spot the badge.
        if (session.amountDue > 0 && !session.isManual) setCollectFor(session);
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

  // Most urgent first: the card that needs someone to walk over to it is the
  // card your eye lands on. Waiting sits after the running timers — nobody is
  // in the building on that booking yet, so it can't be close to expiry.
  const order: Record<OpsStatus, number> = {
    expired: 0,
    expiring: 1,
    active: 2,
    waiting: 3,
    checked_out: 4,
  };
  const sorted = [...withStatus].sort((a, b) => {
    const byStatus = order[a.status] - order[b.status];
    if (byStatus !== 0) return byStatus;
    const ra = remainingMs(a.session, now);
    const rb = remainingMs(b.session, now);
    // Untimed membership visits have no expiry to be near, so they trail the
    // timed cards in their group rather than jumping the queue.
    if (ra == null) return rb == null ? 0 : 1;
    if (rb == null) return -1;
    return ra - rb;
  });
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
        <div className="mx-auto w-full max-w-[1600px] px-4 py-2.5 lg:px-6">
          {/* The nav already names the tool; keep the heading for screen readers. */}
          <h1 className="sr-only">Session Monitor</h1>
          {/* Counts and takings are both one-line summaries, so they share a row
              and the header costs one band instead of three. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <StatBadge label="Waiting" count={counts.waiting} className="bg-purple/15 text-purple" />
              <StatBadge label="Active" count={counts.active} className="bg-green/15 text-green" />
              <StatBadge label="Expiring" count={counts.expiring} className="bg-yellow/25 text-brown" />
              <StatBadge label="Expired" count={counts.expired} className="bg-coral/15 text-coral" />
              <span className="whitespace-nowrap rounded-full bg-ink px-3.5 py-1 text-sm font-black text-cream">
                {kidsInside} <span className="font-bold opacity-70">inside</span>
              </span>
            </div>
            <SalesLine />
          </div>
          {/* Wristband key, up only during the weekend rush that uses it. Gated
              on `loading` too, so the server's clock never renders it. */}
          {!loading && isBandWindow(now) && <BandLegend />}
        </div>
      </header>

      <div className="mx-auto w-full max-w-[1600px] px-4 py-3 lg:px-6">
        <AttendanceAlert />

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
          <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-2.5 pb-24 max-[430px]:grid-cols-2">
            {filtered.map(({ session }) => (
              <OpsSessionCard
                key={session.id}
                session={session}
                onCheckIn={handleCheckIn}
                onUndoCheckIn={handleUndoCheckIn}
                onCheckout={handleCheckout}
                onShowInvoice={setInvoiceFor}
                onCollect={setCollectFor}
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

      {collectFor && (
        <CollectPaymentSheet
          session={collectFor}
          onClose={() => setCollectFor(null)}
          onCollected={(session, amountDue) => {
            setCollectFor(null);
            // Show the new balance at once; the next poll confirms it.
            setOverrides((prev) => ({
              ...prev,
              [session.id]: { ...prev[session.id], amountDue, paid: amountDue <= 0 },
            }));
            fetchSessions();
          }}
        />
      )}

      <AddVisit
        open={showAddForm}
        onClose={() => setShowAddForm(false)}
        onAdded={() => setManualVisits(getManualVisits())}
      />
    </div>
  );
}

/** Which band to stamp for each half hour — same every weekend, by design. */
function BandLegend() {
  return (
    <div className="mt-2 flex max-w-full items-center gap-1.5 overflow-x-auto pb-0.5">
      <span className="shrink-0 text-[11px] font-black uppercase tracking-wide text-ink/40">
        Out by
      </span>
      {BAND_SLOTS.map((band) => (
        <span
          key={band.outBy}
          title={`${band.label} band — out by ${band.outBy}`}
          className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-black ${band.chip}`}
        >
          {band.outByShort}
        </span>
      ))}
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
