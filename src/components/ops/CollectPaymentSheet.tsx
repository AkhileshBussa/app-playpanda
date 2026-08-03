"use client";

import { useState } from "react";
import { PAYMENT_METHODS, type PaymentMethod } from "@/lib/billing/types";
import type { OpsSession } from "@/lib/ops/types";

interface CollectPaymentSheetProps {
  session: OpsSession;
  onClose: () => void;
  /** Payment landed; carries what's still owed so the card can update. */
  onCollected: (session: OpsSession, amountDue: number) => void;
}

const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/**
 * Take a payment at the counter and record it against the invoice. The whole
 * balance is prefilled — typical case is one tap on a method and Record — but
 * the amount is editable for part payments.
 */
export default function CollectPaymentSheet({
  session,
  onClose,
  onCollected,
}: CollectPaymentSheetProps) {
  const due = session.amountDue;
  const [amount, setAmount] = useState(String(due));
  const [method, setMethod] = useState<PaymentMethod>("UPI");
  const [reference, setReference] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const value = parseFloat(amount);
  const valid = !isNaN(value) && value > 0 && value <= due + 0.5;
  const partial = valid && value < due;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving || !valid) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/ops/payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          invoiceNumber: session.invoiceNumber,
          amount: value,
          method,
          transactionRef: reference.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        window.location.reload();
        return;
      }
      if (!res.ok) throw new Error(data.error || "Couldn't record the payment");
      onCollected(session, Number(data.amountDue ?? 0));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't record the payment");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-ink/40" onClick={saving ? undefined : onClose} />

      <div className="relative mx-4 w-full max-w-md rounded-t-chunk bg-cream p-6 shadow-chunk sm:rounded-chunk">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-xl font-black text-ink">Collect payment</h2>
          <button
            onClick={onClose}
            disabled={saving}
            className="text-2xl leading-none text-ink/40 hover:text-ink disabled:opacity-40"
            aria-label="Close"
          >
            &times;
          </button>
        </div>
        <p className="text-sm font-bold text-ink/60">
          {session.invoiceNumber}
          {session.parentName && ` · ${session.parentName}`}
        </p>
        <p className="mt-3 rounded-2xl bg-yellow/25 px-3 py-2.5 text-base font-black text-ink">
          {inr(due)} due
        </p>

        <form onSubmit={submit} className="mt-4 space-y-4">
          <div>
            <label className="mb-1 block px-1 text-sm font-bold uppercase tracking-widest text-ink/50">
              Amount
            </label>
            <input
              type="number"
              inputMode="decimal"
              min={1}
              max={due}
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full rounded-2xl border-2 border-ink/10 bg-white px-4 py-3 text-base font-black text-ink outline-none focus:border-coral"
            />
            {partial && (
              <p className="mt-1 px-1 text-xs font-bold text-ink/50">
                Part payment — {inr(due - value)} will still be due.
              </p>
            )}
            {!valid && amount.trim() !== "" && (
              <p className="mt-1 px-1 text-xs font-bold text-coral">
                Enter an amount between ₹1 and {inr(due)}.
              </p>
            )}
          </div>

          <div>
            <label className="mb-1 block px-1 text-sm font-bold uppercase tracking-widest text-ink/50">
              Paid by
            </label>
            <div className="flex gap-2">
              {PAYMENT_METHODS.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMethod(m)}
                  className={`flex h-11 flex-1 items-center justify-center rounded-full text-base font-black leading-none transition-colors ${
                    method === m ? "bg-ink text-cream" : "bg-white text-ink/60 hover:bg-ink/10"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-1 block px-1 text-sm font-bold uppercase tracking-widest text-ink/50">
              Reference (optional)
            </label>
            <input
              type="text"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="UPI / card reference"
              className="w-full rounded-2xl border-2 border-ink/10 bg-white px-4 py-3 text-base font-bold text-ink outline-none placeholder:font-bold placeholder:text-ink/30 focus:border-coral"
            />
          </div>

          {error && <p className="px-1 text-sm font-bold text-coral">{error}</p>}

          <button
            type="submit"
            disabled={saving || !valid}
            className="w-full rounded-full bg-green py-3.5 text-base font-black text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed disabled:opacity-40 disabled:shadow-none"
          >
            {saving ? "Recording…" : `Record ${inr(valid ? value : due)} ${method}`}
          </button>
        </form>
      </div>
    </div>
  );
}
