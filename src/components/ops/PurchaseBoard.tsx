"use client";

import { useCallback, useEffect, useState } from "react";
import type { PurchaseRecord } from "@/lib/inventory/purchases";
import type { StockProduct } from "@/lib/inventory/products";
import { ReceiveStockSheet, type EditingPurchase } from "./StockBoard";

const rupees = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

/** Play Panda's Swipe books start here. */
const EARLIEST_MONTH = "2026-03";

function currentMonth(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
  }).format(new Date());
}

function monthOptions(): string[] {
  const [year, month] = currentMonth().split("-").map(Number);
  const out: string[] = [];
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

interface BoardData {
  purchases: PurchaseRecord[];
  totalInr: number;
  cashInr: number;
  pendingInr: number;
  label: string;
}

/**
 * What we spent on stock.
 *
 * The sibling of /ops/expenses, and separate from it on purpose: an expense is
 * money gone, a purchase is money turned into something on the shelf. Lumping
 * them together would overstate what the place costs to run.
 *
 * Read live from Swipe, with no local copy — same rule expenses follow. The
 * cash figure is called out because that is the part the drawer felt, and it's
 * the number that has to agree with the cash ledger.
 */
export default function PurchaseBoard({
  isAdmin,
  products,
}: {
  isAdmin: boolean;
  products: StockProduct[];
}) {
  const [data, setData] = useState<BoardData | null>(null);
  const [month, setMonth] = useState(currentMonth());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [raising, setRaising] = useState(false);
  const [editing, setEditing] = useState<EditingPurchase | null>(null);
  /** The purchase awaiting a delete confirmation. */
  const [removing, setRemoving] = useState<PurchaseRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/ops/purchases?month=${month}`);
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

  /** Read the purchase back before opening the form — the list doesn't carry
   *  its lines, and editing from a guess would drop them. */
  async function openEdit(p: PurchaseRecord) {
    setError(null);
    try {
      const res = await fetch(`/api/ops/purchases?ref=${encodeURIComponent(p.ref)}`);
      const body = await res.json();
      if (!res.ok) {
        setError(body.error || "Couldn't open that purchase");
        return;
      }
      const d = body.purchase;
      setEditing({
        ref: d.ref,
        docId: d.docId,
        docNumber: d.docNumber,
        serialNumber: d.serialNumber,
        vendorId: d.vendorId,
        paid: d.paid,
        paymentModes: d.paymentModes,
        lines: d.lines,
      });
    } catch {
      setError("Network error — please retry");
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-3 pb-24">
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
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
          onClick={() => setRaising(true)}
          className="rounded-full bg-coral px-4 py-2 text-sm font-black text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed"
        >
          + New purchase
        </button>
      </div>

      {loading ? (
        <div className="py-24 text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-ink/15 border-t-coral" />
        </div>
      ) : error ? (
        <div className="py-20 text-center">
          <p className="mb-3 text-5xl">🧾</p>
          <p className="mx-auto max-w-sm text-base font-bold text-coral">{error}</p>
        </div>
      ) : !data ? null : (
        <>
          <div className="mt-3 rounded-chunk bg-white p-5 shadow-chunk">
            <p className="text-sm font-black uppercase tracking-wide text-ink/40">{data.label}</p>
            <p className="mt-1 text-4xl font-black text-ink">{rupees(data.totalInr)}</p>
            <p className="mt-0.5 text-sm font-bold text-ink/50">
              {data.purchases.length} purchase{data.purchases.length === 1 ? "" : "s"}
              {/* The cash share is the bit the drawer felt, and the number that
                  has to agree with the ledger's "cash spent on stock". */}
              {data.cashInr > 0 && ` · ${rupees(data.cashInr)} paid in cash`}
              {data.pendingInr > 0 && ` · ${rupees(data.pendingInr)} unpaid`}
            </p>
          </div>

          {data.purchases.length === 0 ? (
            <p className="py-16 text-center text-base font-bold text-ink/40">
              No stock bought this month.
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {data.purchases.map((p) => (
                <li key={p.serialNumber} className="rounded-2xl bg-white p-3.5 shadow-chunk">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-base font-black text-ink">{p.vendor}</p>
                      <p className="text-sm font-bold text-ink/50">
                        {p.date}
                        {p.paymentModes.length > 0 && ` · ${p.paymentModes.join(", ")}`}
                      </p>
                      <p className="text-xs font-bold text-ink/30">
                        {p.serialNumber}
                        {(p.raisedBy || p.createdBy) && ` · ${p.raisedBy || p.createdBy}`}
                      </p>
                      <div className="mt-1.5 flex items-center gap-3">
                        <button
                          onClick={() => openEdit(p)}
                          className="text-xs font-black text-coral underline-offset-2 hover:underline"
                        >
                          Edit
                        </button>
                        {/* Removing one takes stock back off the shelf and, if
                            it was cash, moves the drawer — owner only, same as
                            removing a logged withdrawal. */}
                        {isAdmin && (
                          <button
                            onClick={() => setRemoving(p)}
                            className="text-xs font-black text-ink/40 underline-offset-2 hover:text-coral hover:underline"
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      {isAdmin && <p className="text-lg font-black text-ink">{rupees(p.totalInr)}</p>}
                      {p.pendingInr > 0 && (
                        <span className="rounded-full bg-yellow px-2 py-0.5 text-[11px] font-black uppercase tracking-wide text-ink">
                          {isAdmin ? `${rupees(p.pendingInr)} due` : "unpaid"}
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

      {(raising || editing) && (
        <ReceiveStockSheet
          key={editing?.ref ?? "new"}
          products={products}
          editing={editing}
          onClose={() => {
            setRaising(false);
            setEditing(null);
          }}
          onSaved={() => {
            setRaising(false);
            setEditing(null);
            load();
          }}
        />
      )}

      {removing && (
        <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
          <div className="absolute inset-0 bg-ink/40" onClick={() => setRemoving(null)} />
          <div className="relative w-full max-w-sm rounded-t-chunk bg-cream p-5 sm:rounded-chunk">
            <h2 className="text-xl font-black text-ink">Delete {removing.serialNumber}?</h2>
            {/* Spelled out because none of it is undone by deleting: the two
                consequences people don't expect are the stock and the drawer. */}
            <p className="mt-1.5 text-sm font-bold text-ink/60">
              {rupees(removing.totalInr)} from {removing.vendor}. The stock it added comes back
              off the shelf
              {removing.paymentModes.includes("Cash") &&
                ", and the cash ledger stops counting it as money out of the drawer"}
              . This can&apos;t be undone.
            </p>
            {error && <p className="mt-2 px-1 text-sm font-bold text-coral">{error}</p>}
            <div className="mt-4 flex gap-2">
              <button
                onClick={() => setRemoving(null)}
                className="flex-1 rounded-full bg-white py-3 text-base font-black text-ink/60 hover:bg-ink/10"
              >
                Keep it
              </button>
              <button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    const res = await fetch(
                      `/api/ops/purchases?ref=${encodeURIComponent(removing.ref)}`,
                      { method: "DELETE" }
                    );
                    const body = await res.json().catch(() => ({}));
                    if (!res.ok) {
                      setError(body.error || "Couldn't delete it");
                      return;
                    }
                    setRemoving(null);
                    load();
                  } catch {
                    setError("Network error — please retry");
                  } finally {
                    setBusy(false);
                  }
                }}
                className="flex-1 rounded-full bg-coral py-3 text-base font-black text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed disabled:opacity-40"
              >
                {busy ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
