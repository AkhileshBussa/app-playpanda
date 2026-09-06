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
  const [receiving, setReceiving] = useState(false);
  /** The product whose movements are open. */
  const [viewing, setViewing] = useState<StockProduct | null>(null);
  // Same stand-in for per-person login the other boards use: a shared password
  // can't say who you are, so the form asks.
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
        <button
          onClick={() => setEditing("new")}
          className="shrink-0 rounded-full bg-white px-4 py-2.5 text-sm font-black text-ink/70 shadow-btn transition-all hover:bg-ink/5 active:translate-y-0.5 active:shadow-btn-pressed"
        >
          + Add
        </button>
        <button
          onClick={() => setReceiving(true)}
          className="shrink-0 rounded-full bg-coral px-4 py-2.5 text-sm font-black text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed"
        >
          📥 Receive
        </button>
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
                  onEdit={() => setEditing(p)}
                  onOpen={() => setViewing(p)}
                />
              ))}
            </ul>
          )}
        </>
      )}

      {viewing && <ProductDetailSheet product={viewing} onClose={() => setViewing(null)} />}

      {receiving && products && (
        <ReceiveStockSheet
          products={products}
          staff={staff}
          onClose={() => setReceiving(false)}
          onSaved={() => {
            setReceiving(false);
            load();
          }}
        />
      )}

      {editing && (
        <ProductSheet
          product={editing === "new" ? null : editing}
          staff={staff}
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
  onOpen,
}: {
  product: StockProduct;
  isAdmin: boolean;
  onEdit: () => void;
  onOpen: () => void;
}) {
  return (
    <li className="rounded-2xl bg-white p-3.5 shadow-chunk">
      {/* The card itself opens the movements — the question a stock line
          usually prompts is "where did they all go", not "let me edit this". */}
      <button onClick={onOpen} className="block w-full text-left">
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

      </button>

      <div className="mt-1.5 flex items-center gap-3">
        <button
          onClick={onOpen}
          className="text-xs font-black text-ink/40 underline-offset-2 hover:text-ink/70 hover:underline"
        >
          Stock in &amp; out
        </button>
        <button
          onClick={onEdit}
          className="text-xs font-black text-coral underline-offset-2 hover:underline"
        >
          Edit
        </button>
      </div>
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
  staff,
  onClose,
  onSaved,
}: {
  product: StockProduct | null;
  staff: string[];
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
  // Deliberately starts unpicked — defaulting would pin every price change on
  // whoever happens to sort first.
  const [changedBy, setChangedBy] = useState("");
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
            changedBy,
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

        {/* Anyone at the counter may change a product now, so the record of who
            did is the safeguard that used to be a locked door. */}
        {staff.length > 0 && (
          <label className="mt-3 block">
            <span className="mb-1.5 block px-1 text-sm font-black text-ink/60">Changed by</span>
            <select
              value={changedBy}
              onChange={(e) => setChangedBy(e.target.value)}
              className={inputClass}
            >
              <option value="" disabled>
                Who&apos;s making this change?
              </option>
              {staff.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        )}

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
            disabled={busy || !name.trim() || price === "" || (staff.length > 0 && !changedBy)}
            className="flex-1 rounded-full bg-ink py-3 text-base font-black text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed disabled:opacity-40"
          >
            {busy ? "Saving…" : product ? "Save" : "Add"}
          </button>
        </div>
      </form>
    </div>
  );
}

interface Vendor {
  id: number;
  name: string;
}

interface DraftLine {
  productId: number;
  qty: string;
  cost: string;
}

const PAYMENT_MODES = ["Cash", "UPI", "Card", "Net Banking", "Cheque"] as const;

/**
 * Recording a delivery.
 *
 * This raises a real purchase invoice in Swipe, which is what makes it worth
 * doing here rather than as an expense: Swipe puts the quantity back on the
 * product, and the books treat the money as inventory rather than spend. Pay
 * in cash and it lands on the cash ledger the same evening.
 *
 * Vendors are the ones already bought from — Swipe has no endpoint that lists
 * vendor parties, so the list comes from a year of purchase invoices. In
 * practice stock comes from the same handful of suppliers, and the form says
 * plainly that a brand-new one has to be added in Swipe once.
 *
 * Each line's cost prefills from what the product last cost, because that's
 * usually still true and a wrong cost is worse than an empty one.
 */
export function ReceiveStockSheet({
  products,
  staff,
  onClose,
  onSaved,
}: {
  products: StockProduct[];
  staff: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [vendorId, setVendorId] = useState<number | "">("");
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [paymentMode, setPaymentMode] = useState<(typeof PAYMENT_MODES)[number]>("Cash");
  const [paid, setPaid] = useState(true);
  const [raisedBy, setRaisedBy] = useState("");
  /** Set while adding a supplier who isn't on the list yet. */
  const [newVendor, setNewVendor] = useState<string | null>(null);
  const [addingVendor, setAddingVendor] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/ops/purchases/vendors")
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => setVendors(body?.vendors ?? []))
      .catch(() => {});
  }, []);

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  function addLine(productId: number) {
    if (lines.some((l) => l.productId === productId)) return;
    const p = byId.get(productId);
    setLines([
      ...lines,
      { productId, qty: "1", cost: p && p.costPrice > 0 ? String(p.costPrice) : "" },
    ]);
  }

  const total = lines.reduce((sum, l) => sum + Number(l.qty || 0) * Number(l.cost || 0), 0);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/ops/purchases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vendorId: Number(vendorId),
          paymentMode,
          paid,
          raisedBy,
          lines: lines.map((l) => {
            const p = byId.get(l.productId)!;
            return {
              productId: l.productId,
              name: p.name,
              qty: Number(l.qty || 0),
              unitCostWithTax: Number(l.cost || 0),
              taxRatePercent: p.taxRatePercent,
              unit: p.unit,
            };
          }),
        }),
      });
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

  const valid =
    vendorId !== "" &&
    lines.length > 0 &&
    lines.every((l) => Number(l.qty) > 0) &&
    (staff.length === 0 || raisedBy !== "");

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-ink/40" onClick={busy ? undefined : onClose} />
      <form
        onSubmit={submit}
        className="relative w-full max-w-md rounded-t-chunk bg-cream p-5 sm:rounded-chunk"
      >
        <h2 className="text-xl font-black text-ink">Receive stock</h2>
        <p className="mt-0.5 text-sm font-bold text-ink/50">
          Raises a purchase invoice in Swipe and puts the quantity back on the shelf.
        </p>

        <label className="mt-3 block">
          <span className="mb-1.5 block px-1 text-sm font-black text-ink/60">From</span>
          <select
            value={newVendor === null ? String(vendorId) : "new"}
            onChange={(e) => {
              if (e.target.value === "new") {
                setNewVendor("");
                setVendorId("");
              } else {
                setNewVendor(null);
                setVendorId(e.target.value ? Number(e.target.value) : "");
              }
            }}
            className={inputClass}
          >
            <option value="">Pick a supplier…</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
            <option value="new">+ New supplier…</option>
          </select>
        </label>

        {/* The first purchase from anyone new used to be the one that couldn't
            be recorded here at all. */}
        {newVendor !== null && (
          <div className="mt-2 flex gap-2">
            <input
              value={newVendor}
              onChange={(e) => setNewVendor(e.target.value)}
              placeholder="Supplier's name"
              className={`${inputClass} flex-1`}
            />
            <button
              type="button"
              disabled={!newVendor.trim() || addingVendor}
              onClick={async () => {
                setAddingVendor(true);
                setError(null);
                try {
                  const res = await fetch("/api/ops/purchases/vendors", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name: newVendor.trim() }),
                  });
                  const body = await res.json();
                  if (!res.ok) {
                    setError(body.error || "Couldn't add the supplier");
                    return;
                  }
                  setVendors([...vendors, body.vendor].sort((a, b) => a.name.localeCompare(b.name)));
                  setVendorId(body.vendor.id);
                  setNewVendor(null);
                } catch {
                  setError("Network error — please retry");
                } finally {
                  setAddingVendor(false);
                }
              }}
              className="shrink-0 rounded-2xl bg-ink px-4 text-sm font-black text-cream disabled:opacity-40"
            >
              {addingVendor ? "Adding…" : "Add"}
            </button>
          </div>
        )}

        <label className="mt-3 block">
          <span className="mb-1.5 block px-1 text-sm font-black text-ink/60">Add a product</span>
          <select
            value=""
            onChange={(e) => e.target.value && addLine(Number(e.target.value))}
            className={inputClass}
          >
            <option value="">Pick a product…</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        {lines.length > 0 && (
          <ul className="mt-3 space-y-2">
            {lines.map((l) => {
              const p = byId.get(l.productId);
              return (
                <li key={l.productId} className="rounded-2xl bg-white p-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate text-sm font-black text-ink">{p?.name}</span>
                    <button
                      type="button"
                      onClick={() => setLines(lines.filter((x) => x.productId !== l.productId))}
                      className="shrink-0 text-xs font-black text-coral underline-offset-2 hover:underline"
                    >
                      remove
                    </button>
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      inputMode="decimal"
                      value={l.qty}
                      onChange={(e) =>
                        setLines(
                          lines.map((x) =>
                            x.productId === l.productId
                              ? { ...x, qty: e.target.value.replace(/[^\d.]/g, "") }
                              : x
                          )
                        )
                      }
                      placeholder="Qty"
                      className="w-20 rounded-xl border-2 border-ink/10 bg-cream/60 px-3 py-2 text-sm font-black text-ink outline-none focus:border-coral"
                    />
                    <span className="text-xs font-bold text-ink/40">×</span>
                    <input
                      inputMode="decimal"
                      value={l.cost}
                      onChange={(e) =>
                        setLines(
                          lines.map((x) =>
                            x.productId === l.productId
                              ? { ...x, cost: e.target.value.replace(/[^\d.]/g, "") }
                              : x
                          )
                        )
                      }
                      placeholder="Cost each"
                      className="min-w-0 flex-1 rounded-xl border-2 border-ink/10 bg-cream/60 px-3 py-2 text-sm font-bold text-ink outline-none focus:border-coral"
                    />
                    <span className="shrink-0 text-sm font-black text-ink/70">
                      {rupees(Number(l.qty || 0) * Number(l.cost || 0))}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

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
          <label className="mt-2 flex items-center gap-2 px-1">
            <input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} />
            <span className="text-sm font-bold text-ink/60">
              Already paid{paymentMode === "Cash" && paid ? " — comes off the cash ledger" : ""}
            </span>
          </label>
        </div>

        {staff.length > 0 && (
          <label className="mt-3 block">
            <span className="mb-1.5 block px-1 text-sm font-black text-ink/60">Received by</span>
            <select
              value={raisedBy}
              onChange={(e) => setRaisedBy(e.target.value)}
              className={inputClass}
            >
              <option value="" disabled>
                Who took the delivery?
              </option>
              {staff.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        )}

        {error && <p className="mt-2 px-1 text-sm font-bold text-coral">{error}</p>}

        <div className="mt-4 flex items-center gap-3">
          <div>
            <div className="text-[11px] font-black uppercase tracking-widest text-ink/50">Total</div>
            <div className="text-2xl font-black leading-tight text-ink">{rupees(total)}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full bg-white px-4 py-3 text-base font-black text-ink/60 hover:bg-ink/10"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !valid}
            className="flex-1 rounded-full bg-ink py-3 text-base font-black text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed disabled:opacity-40"
          >
            {busy ? "Saving…" : "Receive"}
          </button>
        </div>
      </form>
    </div>
  );
}
interface Movement {
  date: string;
  direction: "in" | "out";
  qty: number;
  balance: number;
  documentType: string;
  serialNumber: string;
  party: string;
  priceInr: number;
}

interface Change {
  id: string;
  at: number;
  action: "created" | "updated";
  by: string;
  tier: "counter" | "owner";
  summary: string;
}

/**
 * One product's story: every movement of its stock, and every change to the
 * product itself.
 *
 * The two answer different questions and come from different places, so they
 * are shown apart rather than interleaved. Movements are Swipe's own inventory
 * timeline, which is why each line carries a real INV- or PINV- serial — the
 * count and the paperwork can be checked against each other. The change
 * history is ours, because Swipe keeps none and cannot say who moved a price.
 */
function ProductDetailSheet({
  product,
  onClose,
}: {
  product: StockProduct;
  onClose: () => void;
}) {
  const [movements, setMovements] = useState<Movement[] | null>(null);
  const [changes, setChanges] = useState<Change[]>([]);
  const [movementsError, setMovementsError] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/ops/stock/${product.id}`);
        const body = await res.json();
        if (cancelled) return;
        setMovements(body.movements);
        setMovementsError(body.movementsError ?? (res.ok ? null : "Couldn't load"));
        setChanges(body.changes ?? []);
        setIsAdmin(Boolean(body.isAdmin));
      } catch {
        if (!cancelled) setMovementsError("Couldn't load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [product.id]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-ink/40" onClick={onClose} />
      <div className="relative max-h-[92dvh] w-full max-w-md overflow-y-auto rounded-t-chunk bg-cream p-5 sm:rounded-chunk">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-xl font-black text-ink">{product.name}</h2>
            <p className="text-sm font-bold text-ink/50">
              {product.qty} {product.unit || "units"} on hand
              {product.category && ` · ${product.category}`}
            </p>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 text-2xl leading-none text-ink/40 hover:text-ink"
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        {loading ? (
          <div className="py-12 text-center">
            <div className="inline-block h-6 w-6 animate-spin rounded-full border-4 border-ink/15 border-t-coral" />
          </div>
        ) : (
          <>
            <p className="mt-4 text-[11px] font-black uppercase tracking-wide text-ink/40">
              Stock in &amp; out
            </p>
            {movementsError ? (
              <p className="mt-1.5 rounded-2xl bg-coral/15 px-4 py-3 text-sm font-bold text-ink">
                {movementsError}
              </p>
            ) : movements && movements.length > 0 ? (
              <ul className="mt-1.5 space-y-1">
                {movements.map((m, i) => (
                  <li
                    key={`${m.serialNumber}-${i}`}
                    className="flex items-baseline justify-between gap-3 border-b border-ink/5 py-1.5 text-sm"
                  >
                    <span className="min-w-0">
                      <span
                        className={`font-black ${m.direction === "in" ? "text-green" : "text-ink/70"}`}
                      >
                        {m.direction === "in" ? "+" : "−"}
                        {m.qty}
                      </span>
                      <span className="ml-2 font-bold text-ink/50">{m.serialNumber}</span>
                      {m.party && (
                        <span className="ml-1.5 text-xs font-bold text-ink/30">{m.party}</span>
                      )}
                      <br />
                      <span className="text-xs font-bold text-ink/30">
                        {m.date} · {m.documentType === "purchase" ? "received" : "sold"}
                        {isAdmin && m.priceInr > 0 && ` · ₹${Math.round(m.priceInr)} a unit`}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs font-bold text-ink/40">
                      {m.balance} left
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1.5 text-sm font-bold text-ink/40">
                Nothing has moved in the last year.
              </p>
            )}

            <p className="mt-5 text-[11px] font-black uppercase tracking-wide text-ink/40">
              Changes to this product
            </p>
            {changes.length === 0 ? (
              <p className="mt-1.5 text-sm font-bold text-ink/40">
                Never changed from the app.
              </p>
            ) : (
              <ol className="mt-1.5 space-y-1 border-l-2 border-ink/10 pl-3">
                {changes.map((c) => (
                  <li key={c.id} className="text-xs font-bold text-ink/50">
                    <span className="text-ink/70">{c.summary}</span>
                    <br />
                    {new Date(c.at).toLocaleString("en-IN", {
                      timeZone: "Asia/Kolkata",
                      hour: "numeric",
                      minute: "2-digit",
                      day: "numeric",
                      month: "short",
                    })}
                    {c.by && ` · ${c.by}`}
                    <span className="ml-1 rounded-full bg-ink/5 px-1.5 py-0.5 text-[10px] font-black uppercase tracking-wide text-ink/40">
                      {c.tier}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
      </div>
    </div>
  );
}
