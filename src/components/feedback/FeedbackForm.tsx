"use client";

import { useState } from "react";
import Image from "next/image";

/**
 * Customer feedback, in two steps.
 *
 * The star is saved on its own request the moment it's tapped, before anything
 * else is asked. Someone who taps 2 stars and walks away still tells us
 * something — and that's exactly the rating we'd otherwise never hear.
 *
 * 5 stars → invite a Google review. Below 5 → ask what to improve, and keep it
 * private. That's the whole point of asking here first.
 */
export default function FeedbackForm({ googleReviewUrl }: { googleReviewUrl: string }) {
  const [rating, setRating] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [id, setId] = useState<string | null>(null);
  const [improve, setImprove] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(stars: number) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setRating(stars);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating: stars }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error || "Couldn't save — please try again");
        setRating(null);
        return;
      }
      setId(body.id);
    } catch {
      setError("Network error — please try again");
      setRating(null);
    } finally {
      setBusy(false);
    }
  }

  async function patch(payload: Record<string, unknown>) {
    if (!id) return;
    await fetch("/api/feedback", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...payload }),
    }).catch(() => {});
  }

  async function submitImprove(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    await patch({ improve, name, phone });
    setBusy(false);
    setDone(true);
  }

  if (done) {
    return (
      <Shell>
        <p className="text-6xl">🐼</p>
        <h1 className="mt-4 text-3xl font-black text-ink">Thank you!</h1>
        <p className="mt-2 text-lg font-bold text-ink/60">
          We&apos;ve passed this to the team. It really does help.
        </p>
      </Shell>
    );
  }

  // Step 2a — a happy customer: ask for the Google review.
  if (rating === 5) {
    return (
      <Shell>
        <p className="text-6xl">🎉</p>
        <h1 className="mt-4 text-3xl font-black text-ink">You made our day!</h1>
        <p className="mt-2 text-lg font-bold text-ink/60">
          Would you tell Google too? It takes about 20 seconds and helps other families find us.
        </p>

        {googleReviewUrl ? (
          <a
            href={googleReviewUrl}
            target="_blank"
            rel="noreferrer"
            onClick={() => patch({ sentToGoogle: true })}
            className="mt-6 block w-full rounded-full bg-coral py-4 text-lg font-black text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed"
          >
            Review us on Google
          </a>
        ) : (
          <p className="mt-6 rounded-2xl bg-yellow/20 px-4 py-3 text-base font-bold text-brown">
            The Google review link isn&apos;t set up yet — ask the manager to add
            NEXT_PUBLIC_GOOGLE_REVIEW_URL.
          </p>
        )}

        <button
          onClick={() => setDone(true)}
          className="mt-3 w-full py-2 text-base font-bold text-ink/40 underline-offset-2 hover:underline"
        >
          No thanks
        </button>
      </Shell>
    );
  }

  // Step 2b — something fell short: find out what, privately.
  if (rating != null) {
    return (
      <Shell>
        <h1 className="text-3xl font-black text-ink">Sorry we missed the mark</h1>
        <p className="mt-2 text-lg font-bold text-ink/60">
          What could we have done better? This goes straight to the manager.
        </p>

        <form onSubmit={submitImprove} className="mt-5 w-full text-left">
          <textarea
            value={improve}
            onChange={(e) => setImprove(e.target.value)}
            rows={4}
            autoFocus
            placeholder="Tell us what happened…"
            className="w-full rounded-2xl border-2 border-ink/10 bg-white px-4 py-3 text-base font-bold text-ink outline-none placeholder:text-ink/30 focus:border-coral"
          />

          <div className="mt-2 grid grid-cols-2 gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name (optional)"
              className="w-full rounded-2xl border-2 border-ink/10 bg-white px-4 py-3 text-base font-bold text-ink outline-none placeholder:text-ink/30 focus:border-coral"
            />
            <input
              inputMode="numeric"
              maxLength={10}
              value={phone}
              onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))}
              placeholder="Phone (optional)"
              className="w-full rounded-2xl border-2 border-ink/10 bg-white px-4 py-3 text-base font-bold text-ink outline-none placeholder:text-ink/30 focus:border-coral"
            />
          </div>
          <p className="mt-1.5 px-1 text-sm font-bold text-ink/40">
            Leave a number if you&apos;d like us to call you back.
          </p>

          <button
            type="submit"
            disabled={busy}
            className="mt-4 w-full rounded-full bg-ink py-4 text-lg font-black text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed disabled:opacity-40"
          >
            {busy ? "Sending…" : "Send"}
          </button>
        </form>
      </Shell>
    );
  }

  // Step 1 — the rating.
  return (
    <Shell>
      <Image src="/MascotWithoutBG.png" alt="" width={96} height={128} className="h-28 w-auto" />
      <h1 className="mt-4 text-3xl font-black text-ink">How was your visit?</h1>
      <p className="mt-2 text-lg font-bold text-ink/60">Tap a star.</p>

      <div className="mt-6 flex justify-center gap-1">
        {[1, 2, 3, 4, 5].map((star) => (
          <button
            key={star}
            onClick={() => pick(star)}
            onMouseEnter={() => setHovered(star)}
            onMouseLeave={() => setHovered(null)}
            disabled={busy}
            aria-label={`${star} star${star === 1 ? "" : "s"}`}
            className={`text-5xl leading-none transition-all active:scale-90 disabled:opacity-50 sm:text-6xl ${
              (hovered ?? 0) >= star ? "text-yellow" : "text-ink/15"
            }`}
          >
            ★
          </button>
        ))}
      </div>

      {error && <p className="mt-4 text-base font-bold text-coral">{error}</p>}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center px-6 py-10 text-center">
      {children}
    </main>
  );
}
