"use client";

import { useEffect, useState } from "react";

/** Live time-left readout for the checked-in panel. */
export default function Countdown({ endTime }: { endTime: number }) {
  // null until mounted so the server and first client render match.
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  if (now == null) return <span>…</span>;

  const diff = endTime - now;
  if (diff <= 0) return <span>Time&apos;s up!</span>;

  const totalSec = Math.floor(diff / 1000);
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  return (
    <span className="tabular-nums">
      {hrs > 0
        ? `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
        : `${mins}:${String(secs).padStart(2, "0")}`}
    </span>
  );
}
