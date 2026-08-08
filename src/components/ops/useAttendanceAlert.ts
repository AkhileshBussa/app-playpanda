"use client";

import { useEffect, useState } from "react";

interface AlertResponse {
  past: boolean;
  missing: { id: string; name: string }[];
}

const POLL_MS = 5 * 60_000;

/**
 * Who hasn't marked attendance today — empty before the noon IST cutoff, and
 * empty if the staff database is unreachable.
 *
 * Lives in the nav rather than on any one page, because "someone didn't clock
 * in" isn't news about the screen you happen to be looking at. Polls slowly on
 * purpose: it's a fact about the whole day, and nobody needs it to the minute.
 *
 * Never throws and never reports failure. A manager's nav bar must not break
 * because Postgres is having a moment.
 */
export function useAttendanceAlert(): { id: string; name: string }[] {
  const [missing, setMissing] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const res = await fetch("/api/ops/attendance/alert");
        if (!res.ok) return;
        const data: AlertResponse = await res.json();
        if (!stopped) setMissing(data.past ? data.missing : []);
      } catch {
        // Silent by design — see above.
      }
    };
    load();
    const poll = setInterval(load, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(poll);
    };
  }, []);

  return missing;
}
