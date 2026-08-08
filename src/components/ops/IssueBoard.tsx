"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ISSUE_KINDS,
  ISSUE_KIND_ICONS,
  ISSUE_KIND_LABELS,
  ISSUE_PRIORITIES,
  ISSUE_STATUS_LABELS,
  type IssueKind,
  type IssuePriority,
  type IssueStatus,
  type MaintenanceIssue,
} from "@/lib/staff/types";

const when = (ms: number) =>
  new Date(ms).toLocaleDateString("en-IN", { day: "numeric", month: "short" });

const PRIORITY_CHIP: Record<IssuePriority, string> = {
  urgent: "bg-coral text-cream",
  normal: "bg-yellow text-ink",
  low: "bg-ink/10 text-ink/50",
};

const STATUS_CHIP: Record<IssueStatus, string> = {
  open: "bg-coral/15 text-coral",
  in_progress: "bg-yellow/25 text-brown",
  resolved: "bg-green/15 text-green",
};

/** Maintenance requests: what's broken, who said so, and whether it's fixed. */
export default function IssueBoard() {
  const [issues, setIssues] = useState<MaintenanceIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<IssueStatus | "all">("all");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/ops/issues");
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Couldn't load");
      setIssues(body.issues);
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

  async function setStatus(id: string, status: IssueStatus) {
    await fetch("/api/ops/issues", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status, note: "" }),
    });
    load();
  }

  const shown = filter === "all" ? issues : issues.filter((i) => i.status === filter);
  const openCount = issues.filter((i) => i.status !== "resolved").length;

  return (
    <div className="mx-auto w-full max-w-3xl px-3 pb-24">
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1.5 overflow-x-auto">
          {(["all", "open", "in_progress", "resolved"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`whitespace-nowrap rounded-full px-4 py-2 text-sm font-black transition-colors ${
                filter === f ? "bg-ink text-cream" : "bg-white text-ink/60 hover:bg-ink/10"
              }`}
            >
              {f === "all" ? `All · ${openCount} open` : ISSUE_STATUS_LABELS[f]}
            </button>
          ))}
        </div>
        <button
          onClick={() => setAdding(true)}
          className="rounded-full bg-coral px-4 py-2 text-sm font-black text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed"
        >
          + Report issue
        </button>
      </div>

      {loading ? (
        <div className="py-24 text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-ink/15 border-t-coral" />
        </div>
      ) : error ? (
        <p className="py-24 text-center text-base font-bold text-coral">{error}</p>
      ) : shown.length === 0 ? (
        <p className="py-16 text-center text-base font-bold text-ink/40">
          {filter === "all" ? "Nothing reported — all good." : "Nothing here."}
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {shown.map((i) => (
            <li key={i.id} className="rounded-2xl bg-white p-3.5 shadow-chunk">
              <div className="flex items-start gap-3">
                {i.photoUrl ? (
                  <a href={i.photoUrl} target="_blank" rel="noreferrer" className="shrink-0">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={i.photoUrl}
                      alt=""
                      className="h-16 w-16 rounded-xl object-cover"
                    />
                  </a>
                ) : (
                  <span aria-hidden className="shrink-0 text-3xl">
                    {ISSUE_KIND_ICONS[i.kind]}
                  </span>
                )}

                <div className="min-w-0 flex-1">
                  <p className="text-base font-black text-ink">{i.title}</p>
                  <p className="text-sm font-bold text-ink/50">
                    {ISSUE_KIND_LABELS[i.kind]} · {when(i.createdAt)}
                    {i.reportedByName && ` · ${i.reportedByName}`}
                  </p>
                  {i.details && (
                    <p className="mt-0.5 text-sm font-bold text-ink/50">{i.details}</p>
                  )}
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-[11px] font-black uppercase tracking-wide ${PRIORITY_CHIP[i.priority]}`}
                    >
                      {i.priority}
                    </span>
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-[11px] font-black uppercase tracking-wide ${STATUS_CHIP[i.status]}`}
                    >
                      {ISSUE_STATUS_LABELS[i.status]}
                    </span>
                  </div>
                </div>
              </div>

              {i.status !== "resolved" && (
                <div className="mt-2.5 flex gap-1.5">
                  {i.status === "open" && (
                    <button
                      onClick={() => setStatus(i.id, "in_progress")}
                      className="flex-1 rounded-full bg-yellow py-2 text-sm font-black text-ink shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed"
                    >
                      Start
                    </button>
                  )}
                  <button
                    onClick={() => setStatus(i.id, "resolved")}
                    className="flex-1 rounded-full bg-green py-2 text-sm font-black text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed"
                  >
                    Mark fixed
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {adding && (
        <ReportIssueSheet
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function ReportIssueSheet({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [kind, setKind] = useState<IssueKind>("equipment");
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [priority, setPriority] = useState<IssuePriority>("normal");
  const [photoUrl, setPhotoUrl] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function upload(file: File) {
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("folder", "issues");
      const res = await fetch("/api/ops/upload", { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error || "Upload failed");
        return;
      }
      setPhotoUrl(body.url);
    } finally {
      setUploading(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/ops/issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, title, details, priority, photoUrl }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error || "Couldn't save");
        return;
      }
      onAdded();
    } catch {
      setError("Network error — please retry");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto sm:items-center sm:p-4">
      <div
        className="absolute inset-0 bg-ink/40"
        onClick={busy || uploading ? undefined : onClose}
      />
      <form
        onSubmit={submit}
        className="relative w-full max-w-md rounded-t-chunk bg-cream p-5 sm:rounded-chunk"
      >
        <h2 className="text-xl font-black text-ink">Report an issue</h2>

        <div className="mt-3">
          <span className="mb-1.5 block px-1 text-sm font-black text-ink/60">What kind</span>
          <div className="grid grid-cols-3 gap-1.5">
            {ISSUE_KINDS.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                className={`flex flex-col items-center gap-0.5 rounded-2xl px-2 py-2.5 text-xs font-black transition-colors ${
                  kind === k ? "bg-ink text-cream" : "bg-white text-ink/60 hover:bg-ink/10"
                }`}
              >
                <span aria-hidden className="text-lg">
                  {ISSUE_KIND_ICONS[k]}
                </span>
                {ISSUE_KIND_LABELS[k]}
              </button>
            ))}
          </div>
        </div>

        <label className="mt-3 block">
          <span className="mb-1.5 block px-1 text-sm font-black text-ink/60">What&apos;s wrong</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
            placeholder="e.g. Slide handrail is loose"
            className="w-full rounded-2xl border-2 border-ink/10 bg-white px-4 py-3 text-base font-bold text-ink outline-none placeholder:text-ink/30 focus:border-coral"
          />
        </label>

        <label className="mt-3 block">
          <span className="mb-1.5 block px-1 text-sm font-black text-ink/60">Details</span>
          <textarea
            value={details}
            onChange={(e) => setDetails(e.target.value)}
            rows={2}
            placeholder="Optional"
            className="w-full rounded-2xl border-2 border-ink/10 bg-white px-4 py-3 text-base font-bold text-ink outline-none placeholder:text-ink/30 focus:border-coral"
          />
        </label>

        <div className="mt-3">
          <span className="mb-1.5 block px-1 text-sm font-black text-ink/60">Priority</span>
          <div className="flex gap-1.5">
            {ISSUE_PRIORITIES.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPriority(p)}
                className={`flex-1 rounded-full px-3 py-2 text-sm font-black capitalize transition-colors ${
                  priority === p ? "bg-ink text-cream" : "bg-white text-ink/60 hover:bg-ink/10"
                }`}
              >
                {p}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-3">
          <span className="mb-1.5 block px-1 text-sm font-black text-ink/60">Photo</span>
          {photoUrl ? (
            <div className="flex items-center gap-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={photoUrl} alt="" className="h-16 w-16 rounded-xl object-cover" />
              <button
                type="button"
                onClick={() => setPhotoUrl("")}
                className="text-sm font-bold text-coral underline-offset-2 hover:underline"
              >
                Remove
              </button>
            </div>
          ) : (
            <input
              type="file"
              accept="image/*"
              capture="environment"
              onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
              disabled={uploading}
              className="w-full text-sm font-bold text-ink/60 file:mr-3 file:rounded-full file:border-0 file:bg-white file:px-4 file:py-2 file:text-sm file:font-black file:text-ink/60"
            />
          )}
          {uploading && <p className="mt-1 px-1 text-sm font-bold text-ink/40">Uploading…</p>}
        </div>

        {error && <p className="mt-2 px-1 text-sm font-bold text-coral">{error}</p>}

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-full bg-white py-3 text-base font-black text-ink/60 hover:bg-ink/10"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || uploading || !title.trim()}
            className="flex-1 rounded-full bg-ink py-3 text-base font-black text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed disabled:opacity-40"
          >
            {busy ? "Saving…" : "Report"}
          </button>
        </div>
      </form>
    </div>
  );
}
