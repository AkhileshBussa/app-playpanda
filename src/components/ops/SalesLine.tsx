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
 * Set deliberately quiet. This is owner reporting sharing a row with the floor
 * state, and the person working the counter has to read session status past it
 * all evening; they should never have to parse revenue to do that. So the total
 * is the only thing with any weight, the split is small grey text after it, and
 * the caller right-aligns the whole block away from the pills.
 *
 * A mode that took nothing isn't drawn: "Cash ₹0 · Card ₹0" is three quarters
 * of the line on a card-free day and says nothing the total doesn't.
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

  const detail = [
    `${sales.invoiceCount} bill${sales.invoiceCount === 1 ? "" : "s"}`,
    ...modes.map((m) => `${m.label} ${inr.format(m.amount)}`),
  ];

  return (
    <div className="flex flex-wrap items-baseline justify-end gap-x-1.5 gap-y-0.5">
      <span className="whitespace-nowrap text-sm font-black text-ink/70">
        {inr.format(sales.total)}
        <span className="font-bold text-ink/40"> today</span>
      </span>
      {detail.map((part) => (
        <span key={part} className="whitespace-nowrap text-xs font-bold text-ink/40">
          <span aria-hidden className="mr-1.5 text-ink/20">
            ·
          </span>
          {part}
        </span>
      ))}
    </div>
  );
}
