"use client";

import { useEffect, useState } from "react";
import type { OpsSession } from "@/lib/ops/types";

interface InvoiceLine {
  name: string;
  quantity: number;
  amount: number;
}

interface InvoiceDetails {
  invoiceNumber: string;
  customerName: string;
  amount: number;
  paid: boolean;
  lines: InvoiceLine[];
}

interface InvoiceItemsSheetProps {
  session: OpsSession;
  onClose: () => void;
}

const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/** What was billed on the invoice behind a session card. */
export default function InvoiceItemsSheet({ session, onClose }: InvoiceItemsSheetProps) {
  const [details, setDetails] = useState<InvoiceDetails | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/ops/invoice?number=${encodeURIComponent(session.invoiceNumber)}`,
          { cache: "no-store" }
        );
        if (res.status === 401) {
          window.location.reload();
          return;
        }
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) throw new Error(data.error || "Couldn't load the invoice");
        setDetails(data as InvoiceDetails);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Couldn't load the invoice");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session.invoiceNumber]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-ink/40" onClick={onClose} />

      <div className="relative mx-4 w-full max-w-md rounded-t-chunk bg-cream p-6 shadow-chunk sm:rounded-chunk">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-xl font-black text-ink">{session.invoiceNumber}</h2>
          <button
            onClick={onClose}
            className="text-2xl leading-none text-ink/40 hover:text-ink"
            aria-label="Close"
          >
            &times;
          </button>
        </div>
        <p className="mb-4 text-sm font-bold text-ink/60">
          {session.parentName || "Walk-in"}
          {session.phone && ` · ${session.phone}`}
        </p>

        {error ? (
          <p className="rounded-2xl bg-coral/10 px-3 py-2.5 text-sm font-bold text-coral">{error}</p>
        ) : !details ? (
          <p className="py-6 text-center text-sm font-bold text-ink/40">Loading items…</p>
        ) : (
          <>
            <ul className="divide-y divide-ink/5 rounded-2xl bg-white px-4">
              {details.lines.map((line, i) => (
                <li key={`${line.name}-${i}`} className="flex items-baseline gap-3 py-3">
                  <span className="min-w-0 flex-1 text-sm font-black text-ink">{line.name}</span>
                  <span className="shrink-0 text-xs font-bold text-ink/50">×{line.quantity}</span>
                  <span className="shrink-0 text-sm font-black tabular-nums text-ink/70">
                    {inr(line.amount)}
                  </span>
                </li>
              ))}
            </ul>

            <div className="mt-3 flex items-center justify-between px-1">
              <span className="text-sm font-black uppercase tracking-widest text-ink/50">Total</span>
              <span className="text-lg font-black tabular-nums text-ink">{inr(details.amount)}</span>
            </div>
            <div className="mt-2 flex justify-end">
              {details.paid ? (
                <span className="rounded-full bg-green/15 px-3 py-1 text-xs font-black uppercase tracking-wide text-green">
                  Paid
                </span>
              ) : (
                <span className="rounded-full bg-coral/15 px-3 py-1 text-xs font-black uppercase tracking-wide text-coral">
                  {inr(session.amountDue)} due
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
