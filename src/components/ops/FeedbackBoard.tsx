"use client";

import { useEffect, useState } from "react";
import type { Feedback } from "@/lib/staff/types";

const when = (ms: number) =>
  new Date(ms).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });

function Stars({ n }: { n: number }) {
  return (
    <span aria-label={`${n} out of 5`} className="whitespace-nowrap text-base leading-none">
      <span className="text-yellow">{"★".repeat(n)}</span>
      <span className="text-ink/15">{"★".repeat(5 - n)}</span>
    </span>
  );
}

/** What customers said after their visit, newest first. */
export default function FeedbackBoard() {
  const [feedback, setFeedback] = useState<Feedback[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "low">("all");

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/feedback");
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || "Couldn't load");
        setFeedback(body.feedback);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't load");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

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

  const count = feedback.length;
  const average = count ? feedback.reduce((n, f) => n + f.rating, 0) / count : 0;
  const fives = feedback.filter((f) => f.rating === 5).length;
  // Only ratings below 5 are asked what to improve, so those are the ones with
  // something to read.
  const shown = filter === "low" ? feedback.filter((f) => f.rating < 5) : feedback;

  return (
    <div className="mx-auto w-full max-w-3xl px-3 pb-20">
      <div className="mt-3 rounded-chunk bg-white p-5 shadow-chunk">
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
          <div>
            <p className="text-4xl font-black text-ink">{average.toFixed(1)}</p>
            <Stars n={Math.round(average)} />
          </div>
          <div className="text-sm font-bold text-ink/50">
            <p>
              {count} {count === 1 ? "rating" : "ratings"}
            </p>
            <p>
              {fives} five-star ({count ? Math.round((fives / count) * 100) : 0}%)
            </p>
          </div>
        </div>

        {/* Distribution — the shape matters more than the mean. */}
        <div className="mt-4 space-y-1">
          {[5, 4, 3, 2, 1].map((star) => {
            const n = feedback.filter((f) => f.rating === star).length;
            return (
              <div key={star} className="flex items-center gap-2">
                <span className="w-3 shrink-0 text-xs font-black text-ink/50">{star}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-ink/5">
                  <div
                    className={`h-full rounded-full ${star >= 4 ? "bg-green" : star === 3 ? "bg-yellow" : "bg-coral"}`}
                    style={{ width: `${count ? (n / count) * 100 : 0}%` }}
                  />
                </div>
                <span className="w-8 shrink-0 text-right text-xs font-black text-ink/50">{n}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="mt-3 flex gap-1.5">
        {(["all", "low"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-full px-4 py-2 text-sm font-black transition-colors ${
              filter === f ? "bg-ink text-cream" : "bg-white text-ink/60 hover:bg-ink/10"
            }`}
          >
            {f === "all" ? "All" : "Needs attention"}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="py-16 text-center text-base font-bold text-ink/40">
          {filter === "low" ? "No complaints — nice." : "No feedback yet."}
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {shown.map((f) => (
            <li key={f.id} className="rounded-2xl bg-white p-3.5 shadow-chunk">
              <div className="flex items-start justify-between gap-3">
                <Stars n={f.rating} />
                <span className="shrink-0 text-xs font-bold text-ink/30">{when(f.createdAt)}</span>
              </div>
              {f.improve && (
                <p className="mt-1.5 text-base font-bold text-ink">{f.improve}</p>
              )}
              {(f.name || f.phone) && (
                <p className="mt-1 text-sm font-bold text-ink/50">
                  {[f.name, f.phone].filter(Boolean).join(" · ")}
                </p>
              )}
              {f.rating === 5 && f.sentToGoogle && (
                <p className="mt-1 text-xs font-black uppercase tracking-wide text-green">
                  Sent to Google review
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
