"use client";

import { useState } from "react";
import Image from "next/image";

/** Password gate for the ops monitor — sets the ops cookie and reloads. */
export default function OpsLoginGate() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/ops/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        window.location.reload();
        return;
      }
      const data = await res.json().catch(() => ({}));
      setError(data?.error || "Login failed");
    } catch {
      setError("Network error — please try again");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center px-6">
      <Image src="/MascotWithoutBG.png" alt="" width={72} height={96} className="h-24 w-auto" />
      <h1 className="mt-4 text-2xl font-black text-ink">Staff only</h1>
      <p className="mt-1 text-sm font-bold text-ink/60">Enter the ops password to continue.</p>

      <form onSubmit={submit} className="mt-6 w-full rounded-chunk bg-white p-5 shadow-chunk">
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="w-full rounded-2xl border-2 border-ink/10 bg-cream/60 px-4 py-3.5 text-base font-bold text-ink outline-none placeholder:font-bold placeholder:text-ink/30 focus:border-coral"
        />
        {error && <p className="mt-2 px-1 text-sm font-bold text-coral">{error}</p>}
        <button
          type="submit"
          disabled={submitting || !password}
          className="mt-3 w-full rounded-full bg-ink py-3.5 text-base font-black text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed disabled:opacity-40"
        >
          {submitting ? "Checking…" : "Open monitor"}
        </button>
      </form>
    </main>
  );
}
