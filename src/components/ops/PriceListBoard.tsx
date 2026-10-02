"use client";

import { useEffect, useState } from "react";
import { formatInr, packagesFor, PRICE_VERSIONS, type PriceVersion } from "@/lib/pricing";
import { membershipPlans } from "@/lib/members/plans";

interface Snapshot {
  active: PriceVersion;
  ready: Record<PriceVersion, boolean>;
  history: { id: string; at: number; from: PriceVersion | null; to: PriceVersion; by: string }[];
}

const when = (ms: number) =>
  new Date(ms).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });

const rows = [
  ...packagesFor("v1").map((p) => ({
    key: `pkg-${p.id}`,
    label: `Play · ${p.label}`,
    price: (v: PriceVersion) => packagesFor(v).find((x) => x.id === p.id)?.pricePerKid ?? 0,
  })),
  ...membershipPlans("v1").map((p) => ({
    key: `plan-${p.key}`,
    label: p.name,
    price: (v: PriceVersion) => membershipPlans(v).find((x) => x.key === p.key)?.priceWithTax ?? 0,
  })),
];

export default function PriceListBoard() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [confirming, setConfirming] = useState<PriceVersion | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/ops/price-version")
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || "Couldn't load the price list");
        setData(body);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load the price list"));
  }, []);

  const switchTo = async (version: PriceVersion) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/ops/price-version", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version, changedBy: name.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Couldn't switch the price list");
      setData(body);
      setConfirming(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't switch the price list");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-3 pb-24">
      <h1 className="mt-4 text-2xl font-black text-ink">Price list</h1>
      {data && (
        <p className="mt-1 text-sm font-bold text-ink/60">
          Live now: <span className="text-ink">{data.active.toUpperCase()}</span>. Website, counter and
          membership sales all bill from it.
        </p>
      )}

      {error && (
        <div className="mt-3 rounded-2xl bg-coral/10 px-4 py-3 text-sm font-bold text-coral">{error}</div>
      )}

      <div className="mt-4 overflow-x-auto rounded-chunk bg-white p-4 shadow-chunk">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-ink/50">
              <th className="pb-2 font-black">Item</th>
              {PRICE_VERSIONS.map((v) => (
                <th key={v} className="pb-2 text-right font-black">
                  {v.toUpperCase()}
                  {data?.active === v && " · live"}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-t border-ink/5">
                <td className="py-2 font-bold text-ink">{r.label}</td>
                {PRICE_VERSIONS.map((v) => (
                  <td
                    key={v}
                    className={`py-2 text-right font-black ${
                      data?.active === v ? "text-ink" : "text-ink/50"
                    }`}
                  >
                    {formatInr(r.price(v))}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-xs font-bold text-ink/50">
          Socks, extra adults and extra time cost the same on every list.
        </p>
      </div>

      {data && (
        <div className="mt-4 rounded-chunk bg-white p-4 shadow-chunk">
          <label className="block text-sm font-black text-ink" htmlFor="price-switch-name">
            Your name
          </label>
          <input
            id="price-switch-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Recorded with the switch"
            className="mt-1 h-11 w-full rounded-2xl border-2 border-ink/10 px-3 text-base font-bold text-ink focus:border-teal focus:outline-none"
          />
          <div className="mt-3 flex flex-wrap gap-2">
            {PRICE_VERSIONS.filter((v) => v !== data.active).map((v) =>
              confirming === v ? (
                <div key={v} className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-bold text-ink">
                    Switch everything to {v.toUpperCase()} now?
                  </span>
                  <button
                    type="button"
                    disabled={saving || name.trim().length < 2}
                    onClick={() => switchTo(v)}
                    className="h-10 rounded-full bg-coral px-4 text-sm font-black text-cream shadow-btn disabled:opacity-50"
                  >
                    {saving ? "Switching…" : "Yes, switch"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(null)}
                    className="h-10 rounded-full bg-white px-4 text-sm font-black text-ink/60 hover:bg-ink/10"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  key={v}
                  type="button"
                  disabled={!data.ready[v] || name.trim().length < 2}
                  onClick={() => setConfirming(v)}
                  className="h-10 rounded-full bg-ink px-4 text-sm font-black text-cream disabled:opacity-40"
                >
                  Switch to {v.toUpperCase()}
                </button>
              )
            )}
          </div>
          {PRICE_VERSIONS.some((v) => !data.ready[v]) && (
            <p className="mt-2 text-xs font-bold text-ink/50">
              {PRICE_VERSIONS.filter((v) => !data.ready[v])
                .map((v) => v.toUpperCase())
                .join(", ")}{" "}
              can&apos;t go live until every product on it has a Swipe product id.
            </p>
          )}
        </div>
      )}

      {data && data.history.length > 0 && (
        <div className="mt-4 rounded-chunk bg-white p-4 shadow-chunk">
          <h2 className="text-sm font-black text-ink">History</h2>
          <ul className="mt-2 flex flex-col gap-1 text-sm font-bold text-ink/70">
            {data.history.map((h) => (
              <li key={h.id}>
                {when(h.at)} · {h.from?.toUpperCase() ?? "—"} → {h.to.toUpperCase()} · {h.by || "unknown"}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
