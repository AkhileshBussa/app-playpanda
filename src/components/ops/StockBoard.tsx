"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { StockProduct } from "@/lib/inventory/products";

const rupees = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

interface Totals {
  lines: number;
  units: number;
  valueInr: number;
  low: number;
  noCost: number;
  badCost: number;
  noReorderLevel: number;
  negative: number;
}

/**
 * What's on the shelves.
 *
 * Swipe already keeps the count — every sale decrements it, every purchase
 * invoice puts it back — so this is a window onto that, not a second ledger of
 * stock. The kitchen menu is excluded upstream: those are dishes made to
 * order, and counting units of them is meaningless.
 *
 * Sorted by what needs attention rather than alphabetically. A stock page read
 * top-to-bottom should answer "what do I need to do something about" before it
 * answers "what do we have", and on a normal day the top of this list is
 * empty and that IS the answer.
 */
export default function StockBoard({ isAdmin }: { isAdmin: boolean }) {
  const [products, setProducts] = useState<StockProduct[] | null>(null);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** The product being edited, or "new" for a fresh one. Owner only. */
  const [editing, setEditing] = useState<StockProduct | "new" | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/ops/stock");
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Couldn't load");
      setProducts(body.products);
      setTotals(body.totals);
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

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = (products ?? []).filter(
      (p) => !q || p.name.toLowerCase().includes(q) || p.category.toLowerCase().includes(q)
    );
    // Problems first: below zero, then at the reorder level, then everything
    // else by name. Rank keeps the comparison readable.
    const rank = (p: StockProduct) => (p.qty < 0 ? 0 : p.isLow ? 1 : 2);
    return [...matched].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }, [products, query]);

  return (
    <div className="mx-auto w-full max-w-3xl px-3 pb-24">
      <div className="mt-3 flex items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search stock…"
          className="min-w-0 flex-1 rounded-full bg-white px-5 py-2.5 text-sm font-bold text-ink shadow-btn outline-none placeholder:font-bold placeholder:text-ink/30 focus:ring-2 focus:ring-coral"
        />
        {isAdmin && (
          <button
            onClick={() => setEditing("new")}
            className="shrink-0 rounded-full bg-coral px-4 py-2.5 text-sm font-black text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed"
          >
            + Add
          </button>
        )}
      </div>

      {loading ? (
        <div className="py-24 text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-ink/15 border-t-coral" />
        </div>
      ) : error ? (
        <div className="py-20 text-center">
          <p className="mb-3 text-5xl">📦</p>
          <p className="mx-auto max-w-sm text-base font-bold text-coral">{error}</p>
        </div>
      ) : !totals ? null : (
        <>
          <div className="mt-3 rounded-chunk bg-white p-5 shadow-chunk">
            <p className="text-sm font-black uppercase tracking-wide text-ink/40">
              {isAdmin ? "Stock on hand" : "What's on the shelves"}
            </p>
            {isAdmin ? (
              <p className="mt-1 text-4xl font-black text-ink">{rupees(totals.valueInr)}</p>
            ) : (
              <p className="mt-1 text-4xl font-black text-ink">{totals.units}</p>
            )}
            <p className="mt-0.5 text-sm font-bold text-ink/50">
              {totals.lines} product{totals.lines === 1 ? "" : "s"} · {totals.units} unit
              {totals.units === 1 ? "" : "s"} on hand
              {isAdmin && " · valued at what we paid"}
            </p>
          </div>

          {/* Said plainly rather than left for the reader to infer from a page
              of odd-looking rows. Each of these is a data problem upstream,
              not something this page can put right. */}
          {totals.negative > 0 && (
            <Notice>
              <strong className="font-black">
                {totals.negative} product{totals.negative === 1 ? "" : "s"} below zero
              </strong>{" "}
              — sold in Swipe more often than stocked in, so the count has drifted. Their
              quantities aren&apos;t trustworthy until someone counts the shelf and corrects them
              in Swipe.
            </Notice>
          )}
          {isAdmin && totals.noCost + totals.badCost > 0 && (
            <Notice>
              <strong className="font-black">{totals.noCost + totals.badCost} without a usable cost</strong>{" "}
              — {totals.noCost} have none recorded and {totals.badCost} have a cost at or above their
              selling price. No margin is shown for those rather than a made-up one.
            </Notice>
          )}
          {totals.noReorderLevel === totals.lines && totals.lines > 0 && (
            <Notice>
              <strong className="font-black">No reorder levels set</strong> — nothing can be flagged
              as running low until each product has one.
            </Notice>
          )}

          {shown.length === 0 ? (
            <p className="py-16 text-center text-base font-bold text-ink/40">
              Nothing matches {query ? `“${query}”` : "that"}.
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {shown.map((p) => (
                <StockRow
                  key={p.id}
                  product={p}
                  isAdmin={isAdmin}
                  onEdit={isAdmin ? () => setEditing(p) : undefined}
                />
              ))}
            </ul>
          )}
        </>
      )}

      {editing && (
        <ProductSheet
          product={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 rounded-2xl bg-yellow/25 px-4 py-3 text-sm font-bold text-ink">{children}</p>;
}

function StockRow({
  product: p,
  isAdmin,
  onEdit,
}: {
  product: StockProduct;
  isAdmin: boolean;
  /** Undefined for the counter — the catalogue is an owner decision. */
  onEdit?: () => void;
}) {
  return (
    <li className="rounded-2xl bg-white p-3.5 shadow-chunk">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-base font-black text-ink">{p.name}</p>
          <p className="text-sm font-bold text-ink/50">
            {p.category || "Uncategorised"}
            {isAdmin && p.costPrice > 0 && ` · cost ${rupees(p.costPrice)}`}
            {` · sells ${rupees(p.priceWithTax)}`}
          </p>
          {isAdmin && (
            <p className="text-xs font-bold text-ink/30">
              {p.marginInr !== null
                ? `${rupees(p.marginInr)} a unit${p.qty > 0 ? ` · ${rupees(p.stockValueInr)} on the shelf` : ""}`
                : p.marginIssue === "no-cost"
                  ? "No cost recorded — margin unknown"
                  : "Cost is at or above the selling price — the cost looks wrong"}
            </p>
          )}
        </div>
        <div className="shrink-0 text-right">
          <p className={`text-lg font-black ${p.qty < 0 ? "text-coral" : "text-ink"}`}>
            {p.qty}
            <span className="ml-1 text-xs font-bold text-ink/40">{p.unit || "units"}</span>
          </p>
          {p.qty < 0 ? (
            <span className="rounded-full bg-coral px-2 py-0.5 text-[11px] font-black uppercase tracking-wide text-cream">
              below zero
            </span>
          ) : p.isLow ? (
            <span className="rounded-full bg-yellow px-2 py-0.5 text-[11px] font-black uppercase tracking-wide text-ink">
              reorder
            </span>
          ) : null}
        </div>
      </div>

      {onEdit && (
        <button
          onClick={onEdit}
          className="mt-1.5 text-xs font-black text-coral underline-offset-2 hover:underline"
        >
          Edit
        </button>
      )}
    </li>
  );
}

const inputClass =
  "w-full rounded-2xl border-2 border-ink/10 bg-white px-4 py-3 text-base font-bold text-ink outline-none placeholder:text-ink/30 focus:border-coral";

/** India's GST slabs. A product on the wrong one is a tax problem, not a
 *  display one, so it's a fixed choice rather than a free number. */
const TAX_SLABS = [0, 5, 12, 18, 28] as const;

/**
 * Add or edit a catalogue product.
 *
 * Cost and reorder level are the two fields that make the rest of this page
 * work — without a cost there is no margin and no stock value, without a
 * reorder level nothing can ever be flagged as running low — so they sit here
 * as first-class fields rather than being buried under "advanced".
 *
 * Quantity is deliberately absent. Stock moves by selling and by receiving; a
 * page that let someone type a new number over it would be a way to paper over
 * a miscount rather than find it.
 */
function ProductSheet({
  product,
  onClose,
  onSaved,
}: {
  product: StockProduct | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(product?.name ?? "");
  const [price, setPrice] = useState(product ? String(product.priceWithTax) : "");
  const [tax, setTax] = useState<number>(product?.taxRatePercent ?? 18);
  const [unit, setUnit] = useState(product?.unit || "PCS");
  const [category, setCategory] = useState(product?.category ?? "");
  const [cost, setCost] = useState(product && product.costPrice > 0 ? String(product.costPrice) : "");
  const [lowStock, setLowStock] = useState(product?.lowStockAt ? String(product.lowStockAt) : "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const money = (v: string) => v.replace(/[^\d.]/g, "");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        product ? `/api/ops/stock?id=${product.id}` : "/api/ops/stock",
        {
          method: product ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: name.trim(),
            priceWithTax: Number(price || 0),
            taxRatePercent: tax,
            unit: unit.trim() || "PCS",
            category: category.trim(),
            costPrice: Number(cost || 0),
            lowStockAt: Number(lowStock || 0),
          }),
        }
      );
      const body = await res.json();
      if (!res.ok) {
        setError(body.error || "Couldn't save");
        return;
      }
      onSaved();
    } catch {
      setError("Network error — please retry");
    } finally {
      setBusy(false);
    }
  }

  const costNum = Number(cost || 0);
  const priceNum = Number(price || 0);
  const margin = costNum > 0 && priceNum > costNum ? priceNum - costNum : null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-ink/40" onClick={busy ? undefined : onClose} />
      <form
        onSubmit={submit}
        className="relative w-full max-w-md rounded-t-chunk bg-cream p-5 sm:rounded-chunk"
      >
        <h2 className="text-xl font-black text-ink">{product ? "Edit product" : "Add product"}</h2>
        <p className="mt-0.5 text-sm font-bold text-ink/50">
          {product ? `${product.qty} ${product.unit || "units"} on hand` : "This is added to Swipe."}
        </p>

        <label className="mt-3 block">
          <span className="mb-1.5 block px-1 text-sm font-black text-ink/60">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus={!product}
            placeholder="e.g. Water bottle 500ml"
            className={inputClass}
          />
        </label>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <label className="block">
            <span className="mb-1.5 block px-1 text-sm font-black text-ink/60">Sells for</span>
            <input
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(money(e.target.value))}
              placeholder="0"
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block px-1 text-sm font-black text-ink/60">Costs us</span>
            <input
              inputMode="decimal"
              value={cost}
              onChange={(e) => setCost(money(e.target.value))}
              placeholder="0"
              className={inputClass}
            />
          </label>
        </div>
        {margin !== null && (
          <p className="mt-1 px-1 text-xs font-bold text-ink/40">
            ₹{Math.round(margin).toLocaleString("en-IN")} a unit.
          </p>
        )}

        <div className="mt-3">
          <span className="mb-1.5 block px-1 text-sm font-black text-ink/60">GST</span>
          <div className="flex flex-wrap gap-1.5">
            {TAX_SLABS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTax(t)}
                className={`rounded-full px-3.5 py-2 text-sm font-black transition-colors ${
                  tax === t ? "bg-ink text-cream" : "bg-white text-ink/60 hover:bg-ink/10"
                }`}
              >
                {t}%
              </button>
            ))}
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <label className="block">
            <span className="mb-1.5 block px-1 text-sm font-black text-ink/60">Unit</span>
            <input
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              placeholder="PCS"
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block px-1 text-sm font-black text-ink/60">Reorder at</span>
            <input
              inputMode="numeric"
              value={lowStock}
              onChange={(e) => setLowStock(e.target.value.replace(/[^\d]/g, ""))}
              placeholder="0"
              className={inputClass}
            />
          </label>
        </div>

        <label className="mt-3 block">
          <span className="mb-1.5 block px-1 text-sm font-black text-ink/60">Category</span>
          <input
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="e.g. Socks"
            className={inputClass}
          />
        </label>

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
            disabled={busy || !name.trim() || price === ""}
            className="flex-1 rounded-full bg-ink py-3 text-base font-black text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed disabled:opacity-40"
          >
            {busy ? "Saving…" : product ? "Save" : "Add"}
          </button>
        </div>
      </form>
    </div>
  );
}
