"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Re-fetches the server component on an interval so the confirmation screen
 * flips to "checked in" on its own while the customer waits at the counter.
 * Rendered only until check-in happens.
 */
export default function AutoRefresh({ intervalMs = 15_000 }: { intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    const interval = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(interval);
  }, [router, intervalMs]);

  return null;
}
