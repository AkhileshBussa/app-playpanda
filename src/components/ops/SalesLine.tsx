"use client";

import { useCallback, useEffect, useState } from "react";
import type { DaySales } from "@/lib/billing/types";

const inr = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

/**
 * Today's takings in the ops header — self-refreshing, silent on errors.
 *
 * The total is the headline; the payment split is data, so it's set as pills
 * rather than prose, matching the count pills it sits beside. A mode that took
 * nothing isn't drawn: "Cash ₹0 · Card ₹0" is three quarters of the line on a
 * card-free day and says nothing the total doesn't.
 */
export default function SalesLine() {
  const [sales, setSales] = useState<DaySales | null>(null);

  const fetchSales = useCallback(async () => {
    try {
      const res = await fetch("/api/ops/sales");
      if (res.ok) setSales(await res.json());
    } catch {}
  }, []);

  useEffect(() => {
    fetchSales();
    const interval = setInterval(fetchSales, 30_000);
    return () => clearInterval(interval);
  }, [fetchSales]);

  if (!sales) return null;

  const modes = [
    { label: "Cash", amount: sales.cash },
    { label: "Card", amount: sales.card },
    { label: "UPI", amount: sales.upi },
    { label: "Other", amount: sales.other },
  ].filter((m) => m.amount > 0);

  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
      <span className="whitespace-nowrap text-base font-black text-ink">
        {inr.format(sales.total)}
        <span className="font-bold text-ink/50"> today</span>
      </span>
      <span className="whitespace-nowrap text-sm font-bold text-ink/50">
        {sales.invoiceCount} bill{sales.invoiceCount === 1 ? "" : "s"}
      </span>
      {modes.map((m) => (
        <span
          key={m.label}
          className="whitespace-nowrap rounded-full bg-ink/5 px-2.5 py-0.5 text-sm font-bold text-ink/60"
        >
          {m.label} <span className="font-black text-ink/80">{inr.format(m.amount)}</span>
        </span>
      ))}
    </div>
  );
}
