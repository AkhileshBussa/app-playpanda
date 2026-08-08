"use client";

import { useEffect, useState } from "react";
import {
  computeOpsStatus,
  opsEndTime,
  opsStartTime,
  type OpsSession,
} from "@/lib/ops/types";
import { bandForEnd } from "@/lib/ops/bands";

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

/** Minutes are zero-padded so the countdown keeps its width all the way down —
 *  an unpadded 10:00 → 9:59 shortens the string and slides every digit left,
 *  which reads as movement on a board someone is watching from the counter. */
function formatCountdown(diffMs: number): string {
  const totalSec = Math.abs(Math.floor(diffMs / 1000));
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  const mm = String(mins).padStart(2, "0");
  const ss = String(secs).padStart(2, "0");
  return hrs > 0 ? `${hrs}:${mm}:${ss}` : `${mm}:${ss}`;
}

interface OpsSessionCardProps {
  session: OpsSession;
  /** Validate the code and check in; resolves to an error message or null. */
  onCheckIn: (session: OpsSession, code: string) => Promise<string | null>;
  onUndoCheckIn: (session: OpsSession) => void;
  onCheckout: (session: OpsSession, undo: boolean) => void;
  /** Open the invoice's line items; omitted for sessions with no invoice. */
  onShowInvoice?: (session: OpsSession) => void;
  /** Take payment against this session's invoice. */
  onCollect?: (session: OpsSession) => void;
}

export default function OpsSessionCard({
  session,
  onCheckIn,
  onUndoCheckIn,
  onCheckout,
  onShowInvoice,
  onCollect,
}: OpsSessionCardProps) {
  const [now, setNow] = useState(Date.now());
  const status = computeOpsStatus(session, now);
  const ticking = status === "active" || status === "expiring" || status === "expired";

  useEffect(() => {
    if (!ticking) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [ticking]);

  const start = opsStartTime(session);
  const end = opsEndTime(session);
  const untimed = session.durationMinutes <= 0;
  // Memberships get their own color while running (as pp-billing did) — teal is
  // the palette's membership color, whether the punch visit is timed or not.
  const membership = session.isMembership || untimed;

  // Wristband color for the weekend rush — the status colors below stay as they
  // are, so a card still says both "which band" and "how long left". Nothing to
  // sweep for once they've left.
  const band = status === "checked_out" ? null : bandForEnd(end);

  // Palette-only theming per status (brand rule: no colors outside the palette).
  const theme = {
    waiting: { card: "border-purple/50 bg-purple/10", timer: "text-purple", bar: "bg-purple" },
    active: membership
      ? { card: "border-teal/50 bg-teal/10", timer: "text-teal", bar: "bg-teal" }
      : { card: "border-green/50 bg-green/10", timer: "text-green", bar: "bg-green" },
    expiring: { card: "border-yellow bg-yellow/15", timer: "text-brown", bar: "bg-yellow" },
    expired: { card: "border-coral/60 bg-coral/10", timer: "text-coral", bar: "bg-coral" },
    checked_out: { card: "border-ink/10 bg-white opacity-60", timer: "text-ink/40", bar: "bg-ink/30" },
  }[status];

  // How much of the booked time has been used, 0–1. Gives the countdown a shape
  // you can read across the room, where four digits all look alike — a bar
  // that's nearly full says "wrap up" before anyone has focused on the number.
  // Null whenever there's no span to be a fraction of: waiting, untimed
  // membership visits, and sessions that have already left.
  const span = start != null && end != null ? end - start : 0;
  const progress =
    span > 0 && status !== "checked_out"
      ? Math.min(Math.max((now - start!) / span, 0), 1)
      : null;

  const kidNamesDisplay =
    session.kidNames.length > 0 ? session.kidNames.join(", ") : session.parentName || "—";

  return (
    <div className={`flex flex-col rounded-2xl border-2 p-3 transition-all duration-300 ${theme.card}`}>
      {/* Wristband: the color stamped on this session's bands, named out loud so
          it survives bad lighting and color blindness. */}
      {band && (
        <div
          className={`-mx-3 -mt-3 mb-2 rounded-t-xl px-2 py-1 text-center ${band.chip}`}
        >
          <div className="text-sm font-black uppercase tracking-wide">{band.label} band</div>
          <div className="text-[11px] font-bold opacity-75">Out by {band.outBy}</div>
        </div>
      )}

      {/* Kid names | kid count — tapping opens what was billed on the invoice.
          Manual membership visits have no invoice behind them, so they don't. */}
      {(() => {
        const header = (
          <>
            <div
              className={`min-w-0 flex-1 break-words text-lg font-black leading-tight ${
                status === "checked_out" ? "text-ink/40 line-through" : "text-ink"
              }`}
            >
              {kidNamesDisplay}
            </div>
            <div className={`flex shrink-0 items-baseline gap-1 ${theme.timer}`}>
              <span className="text-2xl font-black leading-none">{session.kidCount}</span>
              <span className="text-xs font-bold">{session.kidCount === 1 ? "Kid" : "Kids"}</span>
            </div>
          </>
        );
        return onShowInvoice && !session.isManual ? (
          <button
            type="button"
            onClick={() => onShowInvoice(session)}
            title={`See what's on ${session.invoiceNumber}`}
            className="mb-1.5 flex w-full items-start gap-2 text-left"
          >
            {header}
          </button>
        ) : (
          <div className="mb-1.5 flex items-start gap-2">{header}</div>
        );
      })()}

      {/* Badges: membership marker + amount due (partial payments show the remainder) */}
      {((session.isMembership && status !== "checked_out") ||
        (session.amountDue > 0 && status !== "checked_out")) && (
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {session.isMembership && (
            <span className="rounded-full bg-teal px-2.5 py-0.5 text-xs font-black uppercase tracking-wide text-cream">
              Member
            </span>
          )}
          {session.amountDue > 0 && (
            <span className="rounded-full bg-yellow px-2.5 py-0.5 text-xs font-black uppercase tracking-wide text-ink">
              ₹{session.amountDue.toLocaleString("en-IN")} due
            </span>
          )}
        </div>
      )}

      {/* Timer / waiting state */}
      <div className="flex-1 text-center">
        {status === "waiting" ? (
          <div className="py-1">
            <div className="text-base font-black uppercase tracking-widest text-purple">
              Waiting
            </div>
            <div className="mt-0.5 text-sm font-bold text-ink/50">
              Booked {formatTime(session.bookedAt)} · {session.invoiceNumber}
            </div>
          </div>
        ) : (
          <>
            <div className={`font-mono text-3xl font-black ${theme.timer}`}>
              {status === "checked_out"
                ? "Left"
                : untimed
                  ? "Member"
                  : `${end! - now <= 0 ? "-" : ""}${formatCountdown(end! - now)}`}
            </div>
            {progress != null && (
              <div
                role="presentation"
                className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-ink/10"
              >
                <div
                  className={`h-full rounded-full transition-[width] duration-1000 ease-linear ${theme.bar}`}
                  style={{ width: `${progress * 100}%` }}
                />
              </div>
            )}
            {status !== "checked_out" && !untimed && start != null && (
              <div className="mt-0.5 text-sm font-bold text-ink/50">
                {formatTime(start)} → {formatTime(end!)}
              </div>
            )}
          </>
        )}
      </div>

      {/* Parent */}
      <div className="mt-1.5 truncate text-xs font-bold leading-tight text-ink/40">
        {session.parentName}
        {session.phone && ` · ${session.phone}`}
      </div>

      {/* Money owed is collectable from the card, whatever the play state —
          it's the same counter conversation as check-in. */}
      {onCollect && !session.isManual && session.amountDue > 0 && status !== "checked_out" && (
        <button
          onClick={() => onCollect(session)}
          className="mt-2 w-full rounded-full bg-green py-2 text-sm font-black text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed"
        >
          Collect ₹{session.amountDue.toLocaleString("en-IN")}
        </button>
      )}

      {/* Actions */}
      {status === "waiting" ? (
        <CheckInForm session={session} onCheckIn={onCheckIn} />
      ) : status === "checked_out" ? (
        <button
          onClick={() => onCheckout(session, true)}
          className="mt-2 w-full rounded-full border-2 border-transparent bg-ink/10 py-2 text-sm font-black text-ink/60 transition-colors hover:bg-ink/20"
        >
          Undo
        </button>
      ) : (
        <>
          {/* `active` is precisely "more than the expiring window left", so it
              doubles as the test for a checkout that's probably a misclick. */}
          <CheckoutButton
            early={status === "active"}
            onCheckout={() => onCheckout(session, false)}
          />
          {session.needsCheckIn && session.checkinAt != null && (
            <button
              onClick={() => onUndoCheckIn(session)}
              className="mt-1.5 text-xs font-bold text-ink/40 underline-offset-2 hover:underline"
            >
              Undo check-in
            </button>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Check Out, weighted by how likely the tap is to be the one intended.
 *
 * Ending a session that still has real time on it is almost never deliberate —
 * it's a thumb landing on the wrong card in a grid of near-identical ones. So
 * those get the quiet outline treatment and cost a second tap. Once a session
 * is expiring or expired, checking out is the expected next thing to do, so the
 * button is filled and fires immediately.
 *
 * The confirm is a second tap on the same button rather than a sheet: the hand
 * is already there, and a modal over a board that's being read by two people is
 * a worse interruption than the misclick it prevents.
 */
function CheckoutButton({ early, onCheckout }: { early: boolean; onCheckout: () => void }) {
  const [confirming, setConfirming] = useState(false);

  // Disarm on its own. A card left sitting in "Tap to confirm" is a trap for
  // whoever picks the tablet up next and taps what looks like Check Out.
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 3000);
    return () => clearTimeout(t);
  }, [confirming]);

  const base =
    "mt-2 w-full rounded-full border-2 py-2 text-sm font-black transition-colors";

  if (!early) {
    return (
      <button onClick={onCheckout} className={`${base} border-ink bg-ink text-cream hover:bg-ink/80`}>
        Check Out
      </button>
    );
  }

  return (
    <button
      onClick={() => (confirming ? onCheckout() : setConfirming(true))}
      className={`${base} ${
        confirming
          ? "border-ink bg-ink text-cream"
          : "border-ink/20 text-ink/50 hover:border-ink/40 hover:bg-ink/5"
      }`}
    >
      {confirming ? "Tap to confirm" : "Check Out"}
    </button>
  );
}

/** 4-digit code entry on a waiting card; the server verifies the code. */
function CheckInForm({
  session,
  onCheckIn,
}: {
  session: OpsSession;
  onCheckIn: (session: OpsSession, code: string) => Promise<string | null>;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (code.length < 4 || busy) return;
    setBusy(true);
    setError(null);
    const err = await onCheckIn(session, code);
    if (err) {
      setError(err);
      setBusy(false);
    }
    // On success the card re-renders as checked in; no local state to clean up.
  }

  return (
    <form onSubmit={submit} className="mt-2">
      <div className="flex gap-1.5">
        <input
          type="text"
          inputMode="numeric"
          pattern="\d*"
          maxLength={4}
          value={code}
          onChange={(e) => {
            setCode(e.target.value.replace(/\D/g, ""));
            setError(null);
          }}
          placeholder="Code"
          className="w-0 min-w-0 flex-1 rounded-xl border-2 border-purple/40 bg-white px-2 py-2 text-center font-mono text-base font-black tracking-[0.25em] text-ink outline-none placeholder:font-sans placeholder:text-sm placeholder:font-bold placeholder:tracking-normal placeholder:text-ink/30 focus:border-purple"
        />
        <button
          type="submit"
          disabled={code.length < 4 || busy}
          className="shrink-0 rounded-full bg-purple px-3.5 py-2 text-sm font-black text-cream transition-all hover:bg-purple/85 disabled:opacity-40"
        >
          {busy ? "…" : "Check In"}
        </button>
      </div>
      {error && <p className="mt-1.5 w-full text-center text-base font-black text-coral">{error}</p>}
    </form>
  );
}
