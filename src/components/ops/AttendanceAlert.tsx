"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface AlertData {
  past: boolean;
  missing: { id: string; name: string }[];
  cutoffHour?: number;
}

const POLL_MS = 5 * 60_000;

/**
 * "Who hasn't marked attendance?" on the session monitor, from noon IST.
 *
 * Renders nothing before the cutoff, when everyone is accounted for, or if the
 * staff database is unreachable — the session monitor is the busiest screen in
 * the building and must not gain a banner it can't act on.
 */
export default function AttendanceAlert() {
  const [data, setData] = useState<AlertData | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch("/api/ops/attendance/alert");
        if (!res.ok) return;
        setData(await res.json());
      } catch {
        // Silent: this is a nicety on someone else's page.
      }
    };
    load();
    const poll = setInterval(load, POLL_MS);
    return () => clearInterval(poll);
  }, []);

  if (dismissed || !data?.past || data.missing.length === 0) return null;

  const names = data.missing.map((m) => m.name).join(", ");
  const n = data.missing.length;

  return (
    <div className="mb-3 flex w-fit max-w-full items-start gap-2 rounded-2xl border-2 border-coral/50 bg-coral/10 px-3.5 py-2.5">
      <span aria-hidden className="text-lg leading-none">
        ⚠️
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-black text-coral">
          {n} {n === 1 ? "person hasn't" : "people haven't"} marked attendance today
        </p>
        <p className="text-sm font-bold text-ink/60">{names}</p>
        <Link
          href="/ops/attendance"
          className="mt-0.5 inline-block text-sm font-black text-coral underline-offset-2 hover:underline"
        >
          Open attendance →
        </Link>
      </div>
      <button
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        className="shrink-0 rounded-full px-2 py-0.5 text-lg font-black leading-none text-ink/30 hover:bg-ink/5"
      >
        ×
      </button>
    </div>
  );
}
