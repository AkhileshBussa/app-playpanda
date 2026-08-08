"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  LEAVE_TYPE_LABELS,
  type AttendanceEntry,
  type AttendanceRow,
  type LeaveRequest,
} from "@/lib/staff/types";
import { formatDistance } from "@/lib/staff/geo";

interface BoardData {
  day: string;
  today: string;
  rows: AttendanceRow[];
  history: AttendanceEntry[];
  leaves: LeaveRequest[];
  geofenceRadiusM: number;
}

const time = (ms: number) =>
  new Date(ms).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });

const day = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });

/** Manager view: who's in today, and every leave request ever raised. */
export default function AttendanceBoard() {
  const [data, setData] = useState<BoardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"today" | "leave" | "history">("today");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/ops/attendance");
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
  if (error) {
    return <p className="py-24 text-center text-base font-bold text-coral">{error}</p>;
  }
  if (!data) return null;

  const present = data.rows.filter((r) => r.entry).length;
  const onLeave = data.rows.filter((r) => !r.entry && r.onLeave).length;
  const missing = data.rows.filter((r) => !r.entry && !r.onLeave).length;
  const pending = data.leaves.filter((l) => l.status === "pending");

  return (
    <div className="mx-auto w-full max-w-4xl px-3 pb-20">
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          <Stat label="Present" count={present} className="bg-green/15 text-green" />
          <Stat label="On leave" count={onLeave} className="bg-purple/15 text-purple" />
          <Stat label="Not marked" count={missing} className="bg-coral/15 text-coral" />
        </div>
        <Link
          href="/ops/employees"
          className="rounded-full bg-white px-3.5 py-2 text-sm font-black text-ink/60 hover:bg-ink/10"
        >
          Manage employees
        </Link>
      </div>

      <div className="mt-3 flex gap-1.5 overflow-x-auto pb-1">
        {([
          ["today", "Today"],
          ["leave", pending.length ? `Leave · ${pending.length} to review` : "Leave"],
          ["history", "Last 14 days"],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`whitespace-nowrap rounded-full px-4 py-2 text-sm font-black transition-colors ${
              tab === key ? "bg-ink text-cream" : "bg-white text-ink/60 hover:bg-ink/10"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "today" && <TodayList rows={data.rows} />}
      {tab === "leave" && <LeaveList leaves={data.leaves} onChanged={load} />}
      {tab === "history" && <HistoryList history={data.history} />}
    </div>
  );
}

function Stat({ label, count, className }: { label: string; count: number; className: string }) {
  return (
    <span className={`whitespace-nowrap rounded-full px-3.5 py-1 text-sm font-black ${className}`}>
      {count} {label}
    </span>
  );
}

// ── Today ────────────────────────────────────────────────────────────────────

function TodayList({ rows }: { rows: AttendanceRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="py-16 text-center text-base font-bold text-ink/40">
        No employees yet — add the team from Manage employees.
      </p>
    );
  }

  return (
    <ul className="mt-3 space-y-2">
      {rows.map(({ employee, entry, onLeave }) => (
        <li key={employee.id} className="rounded-2xl bg-white p-3.5 shadow-chunk">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-lg font-black text-ink">
                {employee.name}
                {employee.role === "manager" && (
                  <span className="ml-1.5 rounded-full bg-ink/10 px-2 py-0.5 text-[11px] font-black uppercase tracking-wide text-ink/50">
                    Manager
                  </span>
                )}
              </p>
              {entry ? (
                <p className="text-sm font-bold text-ink/50">
                  In {time(entry.checkinAt)}
                  {entry.checkoutAt != null
                    ? ` · Out ${time(entry.checkoutAt)} · ${(
                        (entry.checkoutAt - entry.checkinAt) / 3_600_000
                      ).toFixed(1)} h`
                    : " · still on shift"}
                </p>
              ) : onLeave ? (
                <p className="text-sm font-bold text-ink/50">
                  {LEAVE_TYPE_LABELS[onLeave.leaveType]} leave
                  {onLeave.reason && ` · ${onLeave.reason}`}
                </p>
              ) : (
                <p className="text-sm font-bold text-ink/50">No entry today</p>
              )}
              {/* Null on entries recorded before the geofence went in. */}
              {entry?.checkin.distanceM != null && (
                <p className="text-xs font-bold text-ink/30">
                  {formatDistance(entry.checkin.distanceM)} from the playzone
                </p>
              )}
            </div>
            <span
              className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-black uppercase tracking-wide ${
                entry
                  ? entry.checkoutAt != null
                    ? "bg-ink/10 text-ink/50"
                    : "bg-green text-cream"
                  : onLeave
                    ? "bg-purple text-cream"
                    : "bg-coral text-cream"
              }`}
            >
              {entry ? (entry.checkoutAt != null ? "Left" : "In") : onLeave ? "Leave" : "Missing"}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

// ── Leave ────────────────────────────────────────────────────────────────────

const STATUS_CHIP: Record<string, string> = {
  pending: "bg-yellow text-ink",
  approved: "bg-green text-cream",
  rejected: "bg-coral text-cream",
};

function LeaveList({ leaves, onChanged }: { leaves: LeaveRequest[]; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);

  async function decide(id: string, status: "approved" | "rejected") {
    setBusy(id);
    try {
      await fetch("/api/ops/leaves", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status, note: "" }),
      });
      onChanged();
    } finally {
      setBusy(null);
    }
  }

  if (leaves.length === 0) {
    return <p className="py-16 text-center text-base font-bold text-ink/40">No leave requested.</p>;
  }

  // Pending first — this tab exists to be acted on, not browsed.
  const sorted = [...leaves].sort(
    (a, b) =>
      Number(b.status === "pending") - Number(a.status === "pending") ||
      b.createdAt - a.createdAt
  );

  return (
    <ul className="mt-3 space-y-2">
      {sorted.map((l) => (
        <li key={l.id} className="rounded-2xl bg-white p-3.5 shadow-chunk">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-lg font-black text-ink">{l.employeeName}</p>
              <p className="text-sm font-bold text-ink/50">
                {day(l.fromDate)}
                {l.toDate !== l.fromDate && ` → ${day(l.toDate)}`} · {l.days}{" "}
                {l.days === 1 ? "day" : "days"} · {LEAVE_TYPE_LABELS[l.leaveType]}
              </p>
              {l.reason && <p className="text-sm font-bold text-ink/50">{l.reason}</p>}
            </div>
            <span
              className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-black uppercase tracking-wide ${STATUS_CHIP[l.status]}`}
            >
              {l.status}
            </span>
          </div>

          {l.status === "pending" && (
            <div className="mt-2.5 flex gap-1.5">
              <button
                onClick={() => decide(l.id, "approved")}
                disabled={busy === l.id}
                className="flex-1 rounded-full bg-green py-2 text-sm font-black text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed disabled:opacity-40"
              >
                Approve
              </button>
              <button
                onClick={() => decide(l.id, "rejected")}
                disabled={busy === l.id}
                className="flex-1 rounded-full bg-white py-2 text-sm font-black text-coral ring-2 ring-coral/30 transition-colors hover:bg-coral/5 disabled:opacity-40"
              >
                Reject
              </button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

// ── History ──────────────────────────────────────────────────────────────────

function HistoryList({ history }: { history: AttendanceEntry[] }) {
  if (history.length === 0) {
    return <p className="py-16 text-center text-base font-bold text-ink/40">Nothing recorded yet.</p>;
  }

  const byDay = new Map<string, AttendanceEntry[]>();
  for (const e of history) {
    const list = byDay.get(e.workDate) ?? [];
    list.push(e);
    byDay.set(e.workDate, list);
  }

  return (
    <div className="mt-3 space-y-4">
      {[...byDay.entries()].map(([date, entries]) => (
        <div key={date}>
          <h3 className="px-1 text-sm font-black uppercase tracking-wide text-ink/40">
            {day(date)}
          </h3>
          <ul className="mt-1.5 space-y-1.5">
            {entries.map((e) => (
              <li
                key={e.id}
                className="flex items-baseline justify-between gap-3 rounded-2xl bg-white px-3.5 py-2.5 shadow-chunk"
              >
                <span className="truncate text-base font-black text-ink">{e.employeeName}</span>
                <span className="shrink-0 text-sm font-bold text-ink/50">
                  {time(e.checkinAt)}
                  {e.checkoutAt != null ? ` → ${time(e.checkoutAt)}` : " → —"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
