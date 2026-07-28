"use client";

import { useCallback, useEffect, useState } from "react";
import type { DaySales } from "@/lib/billing/types";

const inr = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

/** Today's sales in the ops header — self-refreshing, silent on errors. */
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

  return (
    <div className="flex flex-wrap items-baseline justify-center gap-x-2 text-sm font-bold text-ink/50">
      <span className="text-base font-black text-ink">
        {inr.format(sales.total)}
        <span className="font-bold text-ink/50"> today</span>
      </span>
      <span>
        {sales.invoiceCount} bill{sales.invoiceCount === 1 ? "" : "s"}
      </span>
      <span>· Cash {inr.format(sales.cash)}</span>
      <span>· Card {inr.format(sales.card)}</span>
      <span>· UPI {inr.format(sales.upi)}</span>
      {sales.other > 0 && <span>· Other {inr.format(sales.other)}</span>}
    </div>
  );
}
