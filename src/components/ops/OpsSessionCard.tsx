"use client";

import { useEffect, useState } from "react";
import {
  computeOpsStatus,
  opsEndTime,
  opsStartTime,
  type OpsSession,
} from "@/lib/ops/types";

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function formatCountdown(diffMs: number): string {
  const totalSec = Math.abs(Math.floor(diffMs / 1000));
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hrs > 0) return `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

interface OpsSessionCardProps {
  session: OpsSession;
  /** Validate the code and check in; resolves to an error message or null. */
  onCheckIn: (session: OpsSession, code: string) => Promise<string | null>;
  onUndoCheckIn: (session: OpsSession) => void;
  onCheckout: (session: OpsSession, undo: boolean) => void;
}

export default function OpsSessionCard({
  session,
  onCheckIn,
  onUndoCheckIn,
  onCheckout,
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

  // Palette-only theming per status (brand rule: no colors outside the palette).
  const theme = {
    waiting: { card: "border-purple/50 bg-purple/10", timer: "text-purple" },
    active: untimed
      ? { card: "border-teal/50 bg-teal/10", timer: "text-teal" }
      : { card: "border-green/50 bg-green/10", timer: "text-green" },
    expiring: { card: "border-yellow bg-yellow/15", timer: "text-brown" },
    expired: { card: "border-coral/60 bg-coral/10", timer: "text-coral" },
    checked_out: { card: "border-ink/10 bg-white opacity-60", timer: "text-ink/40" },
  }[status];

  const kidNamesDisplay =
    session.kidNames.length > 0 ? session.kidNames.join(", ") : session.parentName || "—";

  return (
    <div className={`flex flex-col rounded-2xl border-2 p-3 transition-all duration-300 ${theme.card}`}>
      {/* Kid names | kid count */}
      <div className="mb-1.5 flex items-start gap-2">
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
      </div>

      {/* Amount-due badge (partial payments show only the remainder) */}
      {session.amountDue > 0 && status !== "checked_out" && (
        <div className="mb-1.5 self-start rounded-full bg-yellow px-2.5 py-0.5 text-xs font-black uppercase tracking-wide text-ink">
          ₹{session.amountDue.toLocaleString("en-IN")} due
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

      {/* Actions */}
      {status === "waiting" ? (
        <CheckInForm session={session} onCheckIn={onCheckIn} />
      ) : (
        <>
          <button
            onClick={() => onCheckout(session, status === "checked_out")}
            className={`mt-2 w-full rounded-full py-2 text-sm font-black transition-colors ${
              status === "checked_out"
                ? "bg-ink/10 text-ink/60 hover:bg-ink/20"
                : "bg-ink text-cream hover:bg-ink/80"
            }`}
          >
            {status === "checked_out" ? "Undo" : "Check Out"}
          </button>
          {status !== "checked_out" && session.needsCheckIn && session.checkinAt != null && (
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
