"use client";

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import {
  LEAVE_TYPES,
  LEAVE_TYPE_LABELS,
  type AttendanceEntry,
  type Employee,
  type LeaveRequest,
  type LeaveType,
} from "@/lib/staff/types";

interface RosterEntry {
  id: string;
  name: string;
  role: string;
}

interface SessionData {
  roster: RosterEntry[];
  employee: Employee | null;
  today?: AttendanceEntry | null;
  leaves?: LeaveRequest[];
  workDate?: string;
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function formatDay(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
  });
}

/** Today in IST as YYYY-MM-DD, for the leave form's date floor. */
function todayLocalISO(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * Employee self-service. Behind a personal 4-digit PIN rather than the shared
 * ops password, so an employee never needs the manager's credential to mark
 * their own attendance — and a leave approval is always attributable.
 */
export default function StaffApp() {
  const [data, setData] = useState<SessionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"today" | "leave">("today");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/staff/session");
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Couldn't load");
      setData(body);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="py-24 text-center">
        <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-ink/15 border-t-coral" />
      </div>
    );
  }

  if (error && !data) {
    return <p className="py-24 text-center text-base font-bold text-coral">{error}</p>;
  }

  if (!data?.employee) {
    return <SignIn roster={data?.roster ?? []} onSignedIn={load} />;
  }

  return (
    <div className="mx-auto w-full max-w-md px-4 pb-16">
      <div className="mt-4 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-black uppercase tracking-wide text-ink/40">Signed in as</p>
          <p className="truncate text-xl font-black text-ink">{data.employee.name}</p>
        </div>
        <button
          onClick={async () => {
            await fetch("/api/staff/session", { method: "DELETE" });
            load();
          }}
          className="shrink-0 rounded-full bg-white px-3.5 py-2 text-sm font-black text-ink/60 hover:bg-ink/10"
        >
          Sign out
        </button>
      </div>

      <div className="mt-3 flex gap-1.5">
        {(["today", "leave"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 rounded-full px-4 py-2 text-sm font-black transition-colors ${
              tab === t ? "bg-ink text-cream" : "bg-white text-ink/60 hover:bg-ink/10"
            }`}
          >
            {t === "today" ? "Attendance" : "Leave"}
          </button>
        ))}
      </div>

      {tab === "today" ? (
        <AttendanceCard
          entry={data.today ?? null}
          onChanged={load}
        />
      ) : (
        <LeaveTab leaves={data.leaves ?? []} onChanged={load} />
      )}
    </div>
  );
}

// ── Sign in ──────────────────────────────────────────────────────────────────

function SignIn({ roster, onSignedIn }: { roster: RosterEntry[]; onSignedIn: () => void }) {
  const [picked, setPicked] = useState<RosterEntry | null>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!picked || pin.length < 4 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/staff/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employeeId: picked.id, pin }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error || "Wrong PIN");
        setPin("");
        setBusy(false);
        return;
      }
      onSignedIn();
    } catch {
      setError("Network error — please retry");
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center px-6">
      <Image src="/MascotWithoutBG.png" alt="" width={72} height={96} className="h-24 w-auto" />
      <h1 className="mt-4 text-2xl font-black text-ink">
        {picked ? `Hi, ${picked.name.split(" ")[0]}` : "Who's here?"}
      </h1>

      {roster.length === 0 ? (
        <p className="mt-3 text-center text-base font-bold text-ink/50">
          No employees have been added yet. A manager can add the team from Staff → Manage
          employees.
        </p>
      ) : !picked ? (
        <div className="mt-6 grid w-full grid-cols-2 gap-2">
          {roster.map((r) => (
            <button
              key={r.id}
              onClick={() => setPicked(r)}
              className="rounded-2xl bg-white px-3 py-4 text-base font-black text-ink shadow-chunk transition-all hover:bg-ink/5 active:translate-y-0.5"
            >
              {r.name}
            </button>
          ))}
        </div>
      ) : (
        <form onSubmit={submit} className="mt-6 w-full rounded-chunk bg-white p-5 shadow-chunk">
          <label className="block px-1 text-sm font-black text-ink/60">Your 4-digit PIN</label>
          <input
            type="password"
            inputMode="numeric"
            pattern="\d*"
            maxLength={4}
            autoFocus
            value={pin}
            onChange={(e) => {
              setPin(e.target.value.replace(/\D/g, ""));
              setError(null);
            }}
            className="mt-2 w-full rounded-2xl border-2 border-ink/10 bg-cream/60 px-4 py-3.5 text-center font-mono text-2xl font-black tracking-[0.5em] text-ink outline-none focus:border-coral"
          />
          {error && <p className="mt-2 px-1 text-sm font-bold text-coral">{error}</p>}
          <button
            type="submit"
            disabled={pin.length < 4 || busy}
            className="mt-3 w-full rounded-full bg-ink py-3.5 text-base font-black text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed disabled:opacity-40"
          >
            {busy ? "Checking…" : "Continue"}
          </button>
          <button
            type="button"
            onClick={() => {
              setPicked(null);
              setPin("");
              setError(null);
            }}
            className="mt-2 w-full py-1 text-sm font-bold text-ink/40 underline-offset-2 hover:underline"
          >
            Not {picked.name}?
          </button>
        </form>
      )}
    </main>
  );
}

// ── Attendance ───────────────────────────────────────────────────────────────

/** Ask the browser for a fix; rejects with a message worth showing. */
function getPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("This device can't share its location"));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, (err) => {
      reject(
        new Error(
          err.code === err.PERMISSION_DENIED
            ? "Location permission is off. Turn it on for this site and try again."
            : "Couldn't get your location — step near a window and try again."
        )
      );
    }, { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 });
  });
}

function AttendanceCard({
  entry,
  onChanged,
}: {
  entry: AttendanceEntry | null;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<"in" | "out" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function mark(action: "in" | "out") {
    setBusy(action);
    setError(null);
    try {
      const pos = await getPosition();
      const res = await fetch("/api/staff/attendance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracyM: pos.coords.accuracy,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error || "Couldn't save");
        return;
      }
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save");
    } finally {
      setBusy(null);
    }
  }

  const done = entry?.checkoutAt != null;

  return (
    <div className="mt-3 rounded-chunk bg-white p-5 shadow-chunk">
      {!entry ? (
        <>
          <p className="text-center text-lg font-black text-ink">Not marked yet today</p>
          <p className="mt-1 text-center text-sm font-bold text-ink/50">
            Tap when you&apos;re at the playzone — your location is checked.
          </p>
        </>
      ) : (
        <div className="space-y-2">
          <Row label="Checked in" value={formatTime(entry.checkinAt)} />
          {entry.checkoutAt != null && (
            <>
              <Row label="Checked out" value={formatTime(entry.checkoutAt)} />
              <Row
                label="Hours"
                value={((entry.checkoutAt - entry.checkinAt) / 3_600_000).toFixed(1)}
              />
            </>
          )}
        </div>
      )}

      {error && (
        <p className="mt-3 rounded-2xl bg-coral/10 px-3 py-2 text-center text-sm font-bold text-coral">
          {error}
        </p>
      )}

      {!done && (
        <button
          onClick={() => mark(entry ? "out" : "in")}
          disabled={busy != null}
          className={`mt-4 w-full rounded-full py-4 text-lg font-black shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed disabled:opacity-50 ${
            entry ? "bg-ink text-cream" : "bg-green text-cream"
          }`}
        >
          {busy ? "Getting your location…" : entry ? "Check out" : "Check in"}
        </button>
      )}

      {done && (
        <p className="mt-4 rounded-2xl bg-green/10 py-3 text-center text-base font-black text-green">
          Done for today — thank you!
        </p>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-sm font-bold text-ink/50">{label}</span>
      <span className="text-lg font-black text-ink">{value}</span>
    </div>
  );
}

// ── Leave ────────────────────────────────────────────────────────────────────

const STATUS_CHIP: Record<string, string> = {
  pending: "bg-yellow text-ink",
  approved: "bg-green text-cream",
  rejected: "bg-coral text-cream",
};

function LeaveTab({ leaves, onChanged }: { leaves: LeaveRequest[]; onChanged: () => void }) {
  const today = todayLocalISO();
  const [fromDate, setFromDate] = useState(today);
  const [toDate, setToDate] = useState(today);
  const [leaveType, setLeaveType] = useState<LeaveType>("casual");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/staff/leaves", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromDate, toDate, leaveType, reason }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error || "Couldn't submit");
        return;
      }
      setReason("");
      onChanged();
    } catch {
      setError("Network error — please retry");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <form onSubmit={submit} className="mt-3 rounded-chunk bg-white p-5 shadow-chunk">
        <h2 className="text-lg font-black text-ink">Apply for leave</h2>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Field label="From">
            <input
              type="date"
              value={fromDate}
              onChange={(e) => {
                setFromDate(e.target.value);
                // Keep the range sane without making the manager read a
                // validation error for the common single-day case.
                if (e.target.value > toDate) setToDate(e.target.value);
              }}
              className="w-full rounded-2xl border-2 border-ink/10 bg-cream/60 px-3 py-3 text-base font-bold text-ink outline-none focus:border-coral"
            />
          </Field>
          <Field label="To">
            <input
              type="date"
              value={toDate}
              min={fromDate}
              onChange={(e) => setToDate(e.target.value)}
              className="w-full rounded-2xl border-2 border-ink/10 bg-cream/60 px-3 py-3 text-base font-bold text-ink outline-none focus:border-coral"
            />
          </Field>
        </div>

        <Field label="Type">
          <div className="flex flex-wrap gap-1.5">
            {LEAVE_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setLeaveType(t)}
                className={`rounded-full px-3.5 py-2 text-sm font-black transition-colors ${
                  leaveType === t ? "bg-ink text-cream" : "bg-cream text-ink/60 hover:bg-ink/10"
                }`}
              >
                {LEAVE_TYPE_LABELS[t]}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Reason">
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder="Optional"
            className="w-full rounded-2xl border-2 border-ink/10 bg-cream/60 px-3 py-3 text-base font-bold text-ink outline-none placeholder:font-bold placeholder:text-ink/30 focus:border-coral"
          />
        </Field>

        {error && <p className="mt-2 px-1 text-sm font-bold text-coral">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="mt-3 w-full rounded-full bg-purple py-3.5 text-base font-black text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed disabled:opacity-40"
        >
          {busy ? "Sending…" : "Send for approval"}
        </button>
      </form>

      <h2 className="mt-6 px-1 text-lg font-black text-ink">My leave</h2>
      {leaves.length === 0 ? (
        <p className="mt-2 px-1 text-base font-bold text-ink/40">Nothing applied for yet.</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {leaves.map((l) => (
            <li key={l.id} className="rounded-2xl bg-white p-3.5 shadow-chunk">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-base font-black text-ink">
                    {formatDay(l.fromDate)}
                    {l.toDate !== l.fromDate && ` → ${formatDay(l.toDate)}`}
                    <span className="ml-1.5 text-sm font-bold text-ink/40">
                      {l.days} {l.days === 1 ? "day" : "days"}
                    </span>
                  </p>
                  <p className="text-sm font-bold text-ink/50">
                    {LEAVE_TYPE_LABELS[l.leaveType]}
                    {l.reason && ` · ${l.reason}`}
                  </p>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-black uppercase tracking-wide ${STATUS_CHIP[l.status]}`}
                >
                  {l.status}
                </span>
              </div>
              {l.decisionNote && (
                <p className="mt-1.5 text-sm font-bold text-ink/50">
                  Manager: {l.decisionNote}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="mt-3 block">
      <span className="mb-1.5 block px-1 text-sm font-black text-ink/60">{label}</span>
      {children}
    </label>
  );
}
