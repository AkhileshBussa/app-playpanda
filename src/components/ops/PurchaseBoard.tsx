"use client";

import { useCallback, useEffect, useState } from "react";
import type { PurchaseRecord } from "@/lib/inventory/purchases";
import type { StockProduct } from "@/lib/inventory/products";
import { ReceiveStockSheet } from "./StockBoard";

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
  const [staff, setStaff] = useState<string[]>([]);

  useEffect(() => {
    fetch("/api/ops/employees")
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        const names = (body?.employees ?? [])
          .filter((e: { active: boolean }) => e.active)
          .map((e: { name: string }) => e.name);
        setStaff(names);
      })
      .catch(() => {});
  }, []);

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

      {raising && (
        <ReceiveStockSheet
          products={products}
          staff={staff}
          onClose={() => setRaising(false)}
          onSaved={() => {
            setRaising(false);
            load();
          }}
        />
      )}
    </div>
  );
}
