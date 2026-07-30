"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";

interface Entry {
  id: string;
  kidName: string;
  className: string;
  at: number;
}

const POLL_MS = 4000;

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

const timeIST = (ms: number) =>
  new Date(ms).toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });

/**
 * School-visit kid log. Built for several note-takers at once: adds are
 * optimistic, everyone's entries merge in via a 4s poll, and a duplicate
 * name+class warns before saving (tap Add again to save anyway).
 */
export default function SchoolLog() {
  const [kidName, setKidName] = useState("");
  const [className, setClassName] = useState("");
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** Entry awaiting removal confirmation (shows the modal). */
  const [confirmRemove, setConfirmRemove] = useState<Entry | null>(null);

  const nameInputRef = useRef<HTMLInputElement>(null);
  // Armed after a duplicate warning; the next submit of the SAME kid forces.
  const forceKey = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/school/list", { cache: "no-store" });
      if (res.status === 401) {
        // Cookie expired mid-shift — show the password gate again.
        window.location.reload();
        return;
      }
      const data = await res.json();
      if (Array.isArray(data.entries)) {
        setEntries(data.entries);
        setError(null);
      }
    } catch {
      // Poll failure is transient (venue wifi) — keep the last good list.
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const name = kidName.replace(/\s+/g, " ").trim();
    const cls = className.replace(/\s+/g, " ").trim();
    if (!name) {
      setError("Enter the kid's name");
      nameInputRef.current?.focus();
      return;
    }
    if (!cls) {
      setError("Enter the class (e.g. 3B)");
      return;
    }

    const key = `${norm(name)}|${norm(cls)}`;
    const force = forceKey.current === key;
    setSaving(true);
    setError(null);
    setNotice(null);

    try {
      const res = await fetch("/api/school/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kidName: name, className: cls, force }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.status === 409 && data.duplicate) {
        forceKey.current = key;
        setNotice(`${name} (${cls}) is already on the list — tap Add again to note them twice.`);
        return;
      }
      if (res.status === 401) {
        window.location.reload();
        return;
      }
      if (!res.ok || !data.entry) {
        throw new Error(data.error || "Couldn't save — please try again");
      }

      // Optimistic append; the next poll reconciles with everyone else's adds.
      setEntries((prev) => [...(prev ?? []), data.entry as Entry]);
      forceKey.current = null;
      setKidName("");
      // Class is kept — kids usually arrive class by class.
      nameInputRef.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save — please try again");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (entry: Entry) => {
    setConfirmRemove(null);
    // Optimistic removal; HDEL on the server is atomic and idempotent.
    setEntries((prev) => (prev ?? []).filter((e) => e.id !== entry.id));
    try {
      const res = await fetch("/api/school/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: entry.id }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setError("Couldn't remove that entry — it may reappear on refresh.");
      refresh();
    }
  };

  // Group by class for display; classes alphabetical, kids in arrival order.
  const groups = useMemo(() => {
    const byClass = new Map<string, { label: string; kids: Entry[] }>();
    for (const entry of entries ?? []) {
      const k = norm(entry.className);
      const group = byClass.get(k) ?? { label: entry.className, kids: [] };
      group.kids.push(entry);
      byClass.set(k, group);
    }
    return [...byClass.values()].sort((a, b) =>
      a.label.localeCompare(b.label, "en", { numeric: true })
    );
  }, [entries]);

  const total = entries?.length ?? 0;
  const today = new Date().toLocaleDateString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "Asia/Kolkata",
  });

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 pb-16 pt-6">
      {/* Header */}
      <header className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-black leading-tight text-ink">School visit log</h1>
          <p className="mt-1 text-sm font-bold text-ink/60">{today}</p>
        </div>
        <Image src="/MascotWithoutBG.png" alt="" width={60} height={80} className="h-16 w-auto" />
      </header>

      <div className="mt-2 flex items-center gap-2">
        <span className="rounded-full bg-green px-3 py-1 text-sm font-black text-cream">
          {total} kid{total === 1 ? "" : "s"}
        </span>
        <span className="min-w-0 flex-1 text-xs font-bold text-ink/50">
          Live — notes from all staff sync automatically
        </span>
        <a
          href="/school/list"
          className="shrink-0 text-sm font-black text-green underline underline-offset-2"
        >
          Full list →
        </a>
      </div>

      {/* Add form */}
      <form onSubmit={add} className="mt-4 rounded-chunk bg-white p-4 shadow-chunk">
        <input
          ref={nameInputRef}
          type="text"
          value={kidName}
          onChange={(e) => {
            setKidName(e.target.value);
            setError(null);
            setNotice(null);
          }}
          placeholder="Kid's name"
          autoFocus
          enterKeyHint="done"
          className="w-full rounded-2xl border-2 border-ink/10 bg-cream/60 px-4 py-3.5 text-base font-bold text-ink outline-none placeholder:font-bold placeholder:text-ink/30 focus:border-coral"
        />
        <div className="mt-3 flex gap-2">
          <input
            type="text"
            value={className}
            onChange={(e) => {
              setClassName(e.target.value);
              setError(null);
              setNotice(null);
            }}
            placeholder="Class — e.g. 3B"
            className="min-w-0 flex-1 rounded-2xl border-2 border-ink/10 bg-cream/60 px-4 py-3.5 text-base font-bold text-ink outline-none placeholder:font-bold placeholder:text-ink/30 focus:border-coral"
          />
          <button
            type="submit"
            disabled={saving}
            className="shrink-0 rounded-full bg-coral px-7 text-base font-black text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed disabled:opacity-50"
          >
            {saving ? "…" : "Add"}
          </button>
        </div>
        {error && <p className="mt-2 px-1 text-sm font-bold text-coral">{error}</p>}
        {notice && (
          <p className="mt-2 rounded-2xl bg-yellow/25 px-3 py-2 text-sm font-bold text-ink/80">
            {notice}
          </p>
        )}
      </form>

      {/* List */}
      {entries === null ? (
        <p className="mt-8 text-center text-sm font-bold text-ink/40">Loading…</p>
      ) : total === 0 ? (
        <p className="mt-8 text-center text-sm font-bold text-ink/40">
          No kids noted yet — add the first one above.
        </p>
      ) : (
        <div className="mt-5 flex flex-col gap-4">
          {groups.map((group) => (
            <section key={group.label} className="rounded-chunk bg-white p-4 shadow-chunk">
              <div className="flex items-baseline justify-between">
                <h2 className="text-sm font-black uppercase tracking-widest text-coral">
                  Class {group.label}
                </h2>
                <span className="text-xs font-black text-ink/50">
                  {group.kids.length} kid{group.kids.length === 1 ? "" : "s"}
                </span>
              </div>
              <ul className="mt-2 divide-y divide-ink/5">
                {group.kids.map((entry, i) => (
                  <li key={entry.id} className="flex items-center gap-3 py-2.5">
                    <span className="w-5 shrink-0 text-right text-xs font-black text-ink/30 tabular-nums">
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-base font-black text-ink">
                      {entry.kidName}
                    </span>
                    <span className="shrink-0 text-xs font-bold text-ink/40">
                      {timeIST(entry.at)}
                    </span>
                    <button
                      type="button"
                      aria-label={`Remove ${entry.kidName}`}
                      onClick={() => setConfirmRemove(entry)}
                      className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-cream text-sm font-black text-ink/40 active:text-coral"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {/* Remove confirmation modal (in-app, not the browser's native dialog) */}
      {confirmRemove && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-6 backdrop-blur-sm"
          onClick={() => setConfirmRemove(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-xs rounded-chunk bg-white p-5 text-center shadow-chunk"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-lg font-black text-ink">
              Remove {confirmRemove.kidName}?
            </div>
            <div className="mt-1 text-sm font-bold text-ink/50">
              Class {confirmRemove.className} · noted {timeIST(confirmRemove.at)}
            </div>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => setConfirmRemove(null)}
                className="flex-1 rounded-full bg-cream py-3 text-sm font-black text-ink transition-all active:translate-y-0.5"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => remove(confirmRemove)}
                className="flex-1 rounded-full bg-coral py-3 text-sm font-black text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed"
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
