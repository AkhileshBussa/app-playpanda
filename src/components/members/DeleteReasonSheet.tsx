"use client";

import { useState } from "react";

interface DeleteReasonSheetProps {
  title: string;
  /** What exactly is being deleted, shown under the title. */
  subject: string;
  /** Consequence of deleting, in plain words. */
  consequence: string;
  /** Tappable common reasons — faster than typing at a busy counter. */
  suggestions: string[];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}

/** Confirms a soft delete and captures why — nothing is deleted without one. */
export default function DeleteReasonSheet({
  title,
  subject,
  consequence,
  suggestions,
  busy,
  error,
  onCancel,
  onConfirm,
}: DeleteReasonSheetProps) {
  const [reason, setReason] = useState("");
  const trimmed = reason.trim();

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-ink/40" onClick={busy ? undefined : onCancel} />

      <div className="relative mx-4 w-full max-w-md rounded-t-chunk bg-cream p-6 shadow-chunk sm:rounded-chunk">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-xl font-black text-ink">{title}</h2>
          <button
            onClick={onCancel}
            disabled={busy}
            className="text-2xl leading-none text-ink/40 hover:text-ink disabled:opacity-40"
            aria-label="Cancel"
          >
            &times;
          </button>
        </div>
        <p className="text-sm font-bold text-ink/60">{subject}</p>
        <p className="mt-3 rounded-2xl bg-white px-3 py-2 text-sm font-bold text-ink/70">
          {consequence}
        </p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (trimmed && !busy) onConfirm(trimmed);
          }}
          className="mt-4"
        >
          <label className="mb-1 block px-1 text-sm font-bold uppercase tracking-widest text-ink/50">
            Reason *
          </label>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this being deleted?"
            autoFocus
            className="w-full rounded-2xl border-2 border-ink/10 bg-white px-4 py-3 text-base font-bold text-ink outline-none placeholder:font-bold placeholder:text-ink/30 focus:border-coral"
          />

          <div className="mt-2 flex flex-wrap gap-1.5">
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setReason(s)}
                className="rounded-full bg-white px-3 py-1.5 text-xs font-black text-ink/60 transition-colors hover:bg-ink/10"
              >
                {s}
              </button>
            ))}
          </div>

          {error && <p className="mt-3 px-1 text-sm font-bold text-coral">{error}</p>}

          <div className="mt-5 flex gap-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="flex-1 rounded-full bg-white py-3 text-base font-black text-ink transition-all active:translate-y-0.5 disabled:opacity-50"
            >
              Keep it
            </button>
            <button
              type="submit"
              disabled={busy || !trimmed}
              className="flex-1 rounded-full bg-coral py-3 text-base font-black text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed disabled:opacity-40 disabled:shadow-none"
            >
              {busy ? "Deleting…" : "Delete"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
