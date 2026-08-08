"use client";

import { useCallback, useEffect, useState } from "react";
import type { ExpenseCategory, ExpenseRecord } from "@/lib/staff/expenses";
import { PAYMENT_MODES, type PaymentMode } from "@/lib/staff/expenses";

interface BoardData {
  expenses: ExpenseRecord[];
  total: number;
  totalPaid: number;
  totalPending: number;
  categories: ExpenseCategory[];
  range: { from: string; to: string; label: string };
}

const rupees = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

/** Play Panda's Swipe books start here — earlier months are empty, so don't
 *  offer them. */
const EARLIEST_MONTH = "2026-03";

/**
 * The current month as YYYY-MM, in IST. Explicitly zoned so the server render
 * and the browser agree — a plain `new Date()` would disagree for the 5½ hours
 * either side of a month boundary and cause a hydration mismatch.
 */
function currentMonth(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
  }).format(new Date());
}

/** Every month from now back to EARLIEST_MONTH, newest first. */
function monthOptions(): string[] {
  const [year, month] = currentMonth().split("-").map(Number);
  const out: string[] = [];
  // Bounded so a bad EARLIEST_MONTH can't spin forever.
  for (let back = 0; back < 240; back++) {
    const d = new Date(Date.UTC(year, month - 1 - back, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    if (key < EARLIEST_MONTH) break;
    out.push(key);
  }
  return out;
}

function monthLabel(key: string): string {
  return new Date(`${key}-15T00:00:00Z`).toLocaleDateString("en-IN", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * This month's spend. Expenses live in Swipe — this page raises them there and
 * reads them straight back, so there's no second copy to reconcile.
 */
export default function ExpenseBoard() {
  const [data, setData] = useState<BoardData | null>(null);
  const [month, setMonth] = useState(currentMonth());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/ops/expenses?month=${month}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Couldn't load");
      setData(body);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load");
    } finally {
      setLoading(false);
    }
  }, [month]);

  useEffect(() => {
    load();
  }, [load]);

  // Spend per category, biggest first — the question a manager actually asks.
  const byCategory = new Map<string, number>();
  for (const e of data?.expenses ?? []) {
    byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + e.totalAmount);
  }
  const categoryTotals = [...byCategory.entries()].sort((a, b) => b[1] - a[1]);

  return (
    <div className="mx-auto w-full max-w-3xl px-3 pb-24">
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        {/* A bare <select> reads as unstyled next to the chunky pills and
            shadowed cards around it, so the native chrome is dropped and the
            brand's own chevron drawn on top. */}
        <div className="relative">
          <select
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            aria-label="Month"
            className="w-full cursor-pointer appearance-none rounded-full bg-white py-2 pl-4 pr-10 text-sm font-black text-ink shadow-btn outline-none transition-all hover:bg-ink/5 focus-visible:ring-2 focus-visible:ring-coral"
          >
            {monthOptions().map((m) => (
              <option key={m} value={m}>
                {monthLabel(m)}
              </option>
            ))}
          </select>
          <span
            aria-hidden
            className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-[10px] leading-none text-ink/40"
          >
            ▼
          </span>
        </div>
        <button
          onClick={() => setAdding(true)}
          className="rounded-full bg-coral px-4 py-2 text-sm font-black text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed"
        >
          + Add expense
        </button>
      </div>

      {loading ? (
        <div className="py-24 text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-ink/15 border-t-coral" />
        </div>
      ) : error ? (
        <div className="py-20 text-center">
          <p className="mb-3 text-5xl">🔑</p>
          <p className="mx-auto max-w-sm text-base font-bold text-coral">{error}</p>
        </div>
      ) : !data ? null : (
        <>
          <div className="mt-3 rounded-chunk bg-white p-5 shadow-chunk">
            <p className="text-sm font-black uppercase tracking-wide text-ink/40">
              {data.range.label}
            </p>
            <p className="mt-1 text-4xl font-black text-ink">{rupees(data.total)}</p>
            <p className="mt-0.5 text-sm font-bold text-ink/50">
              {data.expenses.length} {data.expenses.length === 1 ? "expense" : "expenses"}
              {data.totalPending > 0 && ` · ${rupees(data.totalPending)} unpaid`}
            </p>

            {/* Every category with what it cost, biggest first. Two columns from
                sm up — a busy month runs to 28 categories, and a single column
                of them pushes the expenses themselves off the screen. */}
            {categoryTotals.length > 0 && (
              <dl className="mt-4 grid gap-x-8 sm:grid-cols-2">
                {categoryTotals.map(([category, amount]) => (
                  <div
                    key={category}
                    className="flex items-baseline justify-between gap-3 border-b border-ink/5 py-1.5"
                  >
                    <dt className="min-w-0 truncate text-sm font-bold text-ink/60">{category}</dt>
                    <dd className="shrink-0 text-sm font-black text-ink">{rupees(amount)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>

          {data.expenses.length === 0 ? (
            <p className="py-16 text-center text-base font-bold text-ink/40">
              Nothing spent this month yet.
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {data.expenses.map((e) => (
                <li key={e.id} className="rounded-2xl bg-white p-3.5 shadow-chunk">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-base font-black text-ink">
                        {e.description || e.category}
                      </p>
                      <p className="text-sm font-bold text-ink/50">
                        {e.category} · {e.expenseDate}
                        {e.paymentMode && ` · ${e.paymentMode}`}
                      </p>
                      <p className="text-xs font-bold text-ink/30">
                        {e.serialNumber}
                        {e.createdByName && ` · ${e.createdByName}`}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-lg font-black text-ink">{rupees(e.totalAmount)}</p>
                      {e.amountPending > 0 && (
                        <span className="rounded-full bg-yellow px-2 py-0.5 text-[11px] font-black uppercase tracking-wide text-ink">
                          {rupees(e.amountPending)} due
                        </span>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {adding && (
        <AddExpenseSheet
          categories={data?.categories ?? []}
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

function AddExpenseSheet({
  categories,
  onClose,
  onAdded,
}: {
  categories: ExpenseCategory[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [categoryId, setCategoryId] = useState<number | "new">(categories[0]?.categoryId ?? "new");
  const [newCategory, setNewCategory] = useState("");
  const [description, setDescription] = useState("");
  const [paymentMode, setPaymentMode] = useState<PaymentMode>("UPI");
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
      form.append("folder", "expenses");
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
      const picked = categories.find((c) => c.categoryId === categoryId);
      const res = await fetch("/api/ops/expenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: Number(amount),
          categoryId: picked?.categoryId ?? 0,
          category: picked?.category ?? newCategory,
          ...(categoryId === "new" ? { newCategory } : {}),
          description,
          paymentMode,
          attachments: photoUrl ? [photoUrl] : [],
        }),
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

  const valid =
    Number(amount) > 0 &&
    description.trim().length > 0 &&
    (categoryId !== "new" || newCategory.trim().length > 0);

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
        <h2 className="text-xl font-black text-ink">Add expense</h2>
        <p className="mt-0.5 text-sm font-bold text-ink/50">This is raised in Swipe.</p>

        <label className="mt-3 block">
          <span className="mb-1.5 block px-1 text-sm font-black text-ink/60">Amount</span>
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
            autoFocus
            placeholder="0"
            className="w-full rounded-2xl border-2 border-ink/10 bg-white px-4 py-3 text-2xl font-black text-ink outline-none placeholder:text-ink/20 focus:border-coral"
          />
        </label>

        <label className="mt-3 block">
          <span className="mb-1.5 block px-1 text-sm font-black text-ink/60">Category</span>
          {/* Native select chrome doesn't match the inputs it sits between, so
              it's dropped and our own chevron drawn instead. */}
          <span className="relative block">
            <select
              value={String(categoryId)}
              onChange={(e) =>
                setCategoryId(e.target.value === "new" ? "new" : Number(e.target.value))
              }
              className="w-full cursor-pointer appearance-none rounded-2xl border-2 border-ink/10 bg-white py-3 pl-4 pr-10 text-base font-bold text-ink outline-none focus:border-coral"
            >
              {categories.map((c) => (
                <option key={c.categoryId} value={c.categoryId}>
                  {c.category}
                </option>
              ))}
              <option value="new">+ New category…</option>
            </select>
            <span
              aria-hidden
              className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-[10px] leading-none text-ink/40"
            >
              ▼
            </span>
          </span>
        </label>

        {categoryId === "new" && (
          <input
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
            placeholder="New category name"
            className="mt-2 w-full rounded-2xl border-2 border-ink/10 bg-white px-4 py-3 text-base font-bold text-ink outline-none placeholder:text-ink/30 focus:border-coral"
          />
        )}

        <label className="mt-3 block">
          <span className="mb-1.5 block px-1 text-sm font-black text-ink/60">What was it for</span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. Ball pit balls — 2 bags"
            className="w-full rounded-2xl border-2 border-ink/10 bg-white px-4 py-3 text-base font-bold text-ink outline-none placeholder:text-ink/30 focus:border-coral"
          />
        </label>

        <div className="mt-3">
          <span className="mb-1.5 block px-1 text-sm font-black text-ink/60">Paid by</span>
          <div className="flex flex-wrap gap-1.5">
            {PAYMENT_MODES.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setPaymentMode(m)}
                className={`rounded-full px-3.5 py-2 text-sm font-black transition-colors ${
                  paymentMode === m ? "bg-ink text-cream" : "bg-white text-ink/60 hover:bg-ink/10"
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-3">
          <span className="mb-1.5 block px-1 text-sm font-black text-ink/60">Bill photo</span>
          {photoUrl ? (
            <div className="flex items-center gap-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={photoUrl} alt="Bill" className="h-16 w-16 rounded-xl object-cover" />
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
            disabled={busy || uploading || !valid}
            className="flex-1 rounded-full bg-ink py-3 text-base font-black text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed disabled:opacity-40"
          >
            {busy ? "Saving…" : "Add"}
          </button>
        </div>
      </form>
    </div>
  );
}
