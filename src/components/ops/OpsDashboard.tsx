"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { computeOpsStatus, opsEndTime, type OpsSession, type OpsStatus } from "@/lib/ops/types";
import { BAND_SLOTS, isBandWindow } from "@/lib/ops/bands";
import { getManualVisits, manualToOpsSession, type ManualVisit } from "@/lib/ops/manual";
import OpsSessionCard from "./OpsSessionCard";
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

  // On the combined board a session that's left is history — it can't need
  // anything, so it doesn't get card-sized real estate next to sessions that
  // do. It collapses to a line, below everything live, still one tap from Undo.
  // The Left tab is where you go to actually look at them, so cards stay there.
  const collapseLeft = filter === "all";
  const cards = collapseLeft ? filtered.filter((s) => s.status !== "checked_out") : filtered;
  const leftRows = collapseLeft ? filtered.filter((s) => s.status === "checked_out") : [];

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

  // One row, not two: the counts and the filters were always the same list of
  // states, so the pill that tells you there are 3 expiring is the pill that
  // shows you which 3. Lifecycle order, not the urgency order the cards use —
  // these are a fixed taxonomy and shouldn't move around under the finger.
  //
  // Selected reads as the status colour filled in, unselected as the same
  // colour tinted, so choosing a filter never costs the colour semantics.
  const filters: { key: Filter; label: string; count: number; on: string; off: string }[] = [
    {
      key: "all",
      label: "All",
      count: withStatus.length,
      on: "bg-ink text-cream",
      off: "bg-white text-ink/60 hover:bg-ink/10",
    },
    {
      key: "waiting",
      label: "Waiting",
      count: counts.waiting,
      on: "bg-purple text-cream",
      off: "bg-purple/15 text-purple hover:bg-purple/25",
    },
    {
      key: "active",
      label: "Active",
      count: counts.active,
      on: "bg-green text-cream",
      off: "bg-green/15 text-green hover:bg-green/25",
    },
    {
      key: "expiring",
      label: "Expiring",
      count: counts.expiring,
      on: "bg-yellow text-ink",
      off: "bg-yellow/25 text-brown hover:bg-yellow/40",
    },
    {
      key: "expired",
      label: "Expired",
      count: counts.expired,
      on: "bg-coral text-cream",
      off: "bg-coral/15 text-coral hover:bg-coral/25",
    },
    {
      key: "checked_out",
      label: "Left",
      count: counts.checked_out,
      on: "bg-ink text-cream",
      off: "bg-ink/10 text-ink/50 hover:bg-ink/20",
    },
  ];

  return (
    <div className="min-h-dvh">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b-2 border-ink/5 bg-cream/95 backdrop-blur">
        <div className="mx-auto w-full max-w-[1600px] px-4 py-2.5 lg:px-6">
          {/* The nav already names the tool; keep the heading for screen readers. */}
          <h1 className="sr-only">Session Monitor</h1>
          {/* Session state on the left, takings pushed to the far right. They
              share a row to keep the header one band, but they're read by
              different people for different reasons, so they don't interleave. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              {filters.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setFilter(f.key)}
                  aria-pressed={filter === f.key}
                  className={`whitespace-nowrap rounded-full px-3.5 py-1 text-sm font-black transition-colors ${
                    filter === f.key ? f.on : f.off
                  }`}
                >
                  {f.count} <span className="font-bold opacity-80">{f.label}</span>
                </button>
              ))}
              <span className="ml-1 whitespace-nowrap rounded-full border-2 border-ink px-3 py-0.5 text-sm font-black text-ink">
                {kidsInside} <span className="font-bold opacity-60">inside</span>
              </span>
            </div>
            <div className="ml-auto">
              <SalesLine />
            </div>
          </div>
          {/* Wristband key, up only during the weekend rush that uses it. Gated
              on `loading` too, so the server's clock never renders it. */}
          {!loading && isBandWindow(now) && <BandLegend />}
        </div>
      </header>

      <div className="mx-auto w-full max-w-[1600px] px-4 py-3 lg:px-6">
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
          <div className="pb-24">
            {cards.length > 0 && (
              // Cards get their extra width from a bigger minimum, NOT from
              // auto-fit. auto-fit collapses the empty tracks, so track width
              // depends on how many sessions happen to exist — two sessions got
              // half the board each, and capping the card then left the slack
              // stranded inside the track as a gap between the two cards.
              //
              // auto-fill keeps the tracks uniform whatever the count, so every
              // card is the same width and the slack always collects at the end
              // of the row. 280 rather than the old 210 is where the widening
              // actually comes from: four ~300px cards to a row on the counter
              // screen instead of five ~240px ones.
              //
              // (A max on the track — minmax(210px,420px) — does not work: the
              // repeat count is computed from the max, so it yields two columns.)
              <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-2.5 max-[430px]:grid-cols-2">
                {cards.map(({ session }) => (
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
            {leftRows.length > 0 && (
              // Capped rather than run to the container edge: these are one-line
              // list items, and stretched across a wide board the name and the
              // Undo end up a screen apart. The cap also keeps them clear of the
              // floating add button in the bottom-right corner.
              <div className={`max-w-3xl space-y-1 ${cards.length > 0 ? "mt-4" : ""}`}>
                <p className="px-1 pb-0.5 text-xs font-black uppercase tracking-wide text-ink/30">
                  Left · {leftRows.length}
                </p>
                {leftRows.map(({ session }) => (
                  <LeftRow
                    key={session.id}
                    session={session}
                    onUndo={() => handleCheckout(session, true)}
                  />
                ))}
              </div>
            )}
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

/**
 * A session that's already left, on the combined board: one line, grey, with
 * the Undo that's the only thing anyone still needs from it.
 *
 * Same fields the card leads with (who, how many, state, action) so it reads as
 * a compressed card rather than a different kind of object.
 */
function LeftRow({ session, onUndo }: { session: OpsSession; onUndo: () => void }) {
  const name =
    session.kidNames.length > 0 ? session.kidNames.join(", ") : session.parentName || "—";

  return (
    <div className="flex items-center gap-2.5 rounded-xl border-2 border-ink/10 bg-white px-3 py-1.5">
      <span className="min-w-0 flex-1 truncate text-sm font-black text-ink/45">{name}</span>
      <span className="shrink-0 text-sm font-bold text-ink/35">
        {session.kidCount} {session.kidCount === 1 ? "kid" : "kids"}
      </span>
      <span className="shrink-0 rounded-full bg-ink/10 px-2 py-0.5 text-[11px] font-black uppercase tracking-wide text-ink/45">
        Left
      </span>
      <button
        onClick={onUndo}
        className="shrink-0 text-xs font-black text-ink/45 underline-offset-2 hover:text-ink hover:underline"
      >
        Undo
      </button>
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
