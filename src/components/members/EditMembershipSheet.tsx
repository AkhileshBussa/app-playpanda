"use client";

import { useState } from "react";
import type { Membership } from "@/lib/members/types";
import { PAYMENT_METHODS, type PaymentMethod } from "@/lib/billing/types";

interface EditMembershipSheetProps {
  membership: Membership;
  onClose: () => void;
  onSaved: (membership: Membership, warning: string | null) => void;
}

const inputClass =
  "w-full rounded-2xl border-2 border-ink/10 bg-white px-4 py-3 text-base font-bold text-ink outline-none placeholder:font-bold placeholder:text-ink/30 focus:border-coral";

const labelClass = "mb-1 block px-1 text-sm font-bold uppercase tracking-widest text-ink/50";

const todayIST = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

const istDay = (ms: number) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));

const prettyDate = (d: string) =>
  new Date(`${d}T12:00:00+05:30`).toLocaleDateString("en-IN", {
    day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata",
  });

const chip = (on: boolean) =>
  `rounded-full px-4 py-2 text-sm font-black transition-all ${
    on ? "bg-coral text-cream shadow-btn" : "bg-white text-ink/60"
  }`;

/**
 * Fix what was typed wrong on a membership: the parent's name, the kids, the
 * day it's recorded under, how the sale was paid, the notes.
 *
 * The plan and what it's worth are shown but not editable — the sale invoice
 * in Swipe already says what was sold, and an edit here must never contradict
 * it. "Paid by" corrects our ledger only, and says so.
 */
export default function EditMembershipSheet({
  membership,
  onClose,
  onSaved,
}: EditMembershipSheetProps) {
  const [customerName, setCustomerName] = useState(membership.customerName);
  const [kidNames, setKidNames] = useState(membership.kidNames);
  const [createdOn, setCreatedOn] = useState(istDay(membership.createdAt));
  const [paidBy, setPaidBy] = useState<PaymentMethod>(
    (PAYMENT_METHODS as readonly string[]).includes(membership.paidBy)
      ? (membership.paidBy as PaymentMethod)
      : PAYMENT_METHODS[0]
  );
  const [paidByRef, setPaidByRef] = useState(membership.paidByRef);
  const [notes, setNotes] = useState(membership.notes);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canEditPaidBy = membership.salePaymentId != null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/members/edit", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          membershipId: membership.id,
          customerName: customerName.trim(),
          kidNames: kidNames.trim(),
          createdOn,
          notes: notes.trim(),
          paidBy: canEditPaidBy ? paidBy : undefined,
          paidByRef: canEditPaidBy ? paidByRef.trim() : "",
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        window.location.reload();
        return;
      }
      if (!res.ok || !data.membership) {
        throw new Error(data.error || "Couldn't save the changes — please try again");
      }
      onSaved(data.membership as Membership, (data.warning as string) ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the changes — please try again");
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-ink/40" onClick={saving ? undefined : onClose} />

      <div className="relative mx-4 max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-chunk bg-cream p-6 shadow-chunk sm:rounded-chunk">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-xl font-black text-ink">Edit membership</h2>
          <button
            onClick={onClose}
            disabled={saving}
            className="text-2xl leading-none text-ink/40 hover:text-ink disabled:opacity-40"
            aria-label="Cancel"
          >
            &times;
          </button>
        </div>
        <p className="text-sm font-bold text-ink/60">
          {membership.planName} · {membership.phone}
          {membership.saleInvoiceNumber && ` · sale ${membership.saleInvoiceNumber}`}
        </p>

        <form onSubmit={submit} className="mt-4 space-y-4">
          <div>
            <label className={labelClass}>Parent&apos;s name *</label>
            <input
              type="text"
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              className={inputClass}
              required
            />
          </div>

          <div>
            <label className={labelClass}>Kid names</label>
            <input
              type="text"
              value={kidNames}
              onChange={(e) => setKidNames(e.target.value)}
              placeholder="e.g. Nihira, Advik"
              className={inputClass}
            />
          </div>

          <div>
            <label className={labelClass}>Created on</label>
            <input
              type="date"
              value={createdOn}
              max={todayIST()}
              onChange={(e) => setCreatedOn(e.target.value)}
              className={inputClass}
            />
            <p className="mt-1 px-1 text-xs font-bold text-ink/40">
              The day this membership sits under, and the day it starts. Expiry stays{" "}
              {prettyDate(membership.expiresOn)} — as sold.
            </p>
          </div>

          <div>
            <label className={labelClass}>Paid by</label>
            <div className="flex flex-wrap gap-1.5">
              {PAYMENT_METHODS.map((m) => (
                <button
                  key={m}
                  type="button"
                  disabled={!canEditPaidBy}
                  onClick={() => setPaidBy(m)}
                  className={`${chip(canEditPaidBy && paidBy === m)} disabled:opacity-40`}
                >
                  {m}
                </button>
              ))}
            </div>
            {canEditPaidBy ? (
              <>
                {paidBy === "Card" && (
                  <input
                    type="text"
                    value={paidByRef}
                    onChange={(e) => setPaidByRef(e.target.value)}
                    placeholder="Card reference (optional)"
                    className={`${inputClass} mt-2`}
                  />
                )}
                <p className="mt-1 px-1 text-xs font-bold text-ink/40">
                  Corrects our ledger only — Swipe keeps the method it recorded.
                </p>
              </>
            ) : (
              <p className="mt-1 px-1 text-xs font-bold text-ink/40">
                {membership.salePaymentCount > 1
                  ? "More than one payment is recorded against this sale — fix it on the invoice."
                  : "No payment of ours is recorded against this sale, so there's nothing to correct here."}
              </p>
            )}
          </div>

          <div>
            <label className={labelClass}>Notes</label>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Anything the counter should know"
              className={inputClass}
            />
          </div>

          <p className="rounded-2xl bg-white px-3 py-2 text-xs font-bold text-ink/60">
            The plan, its plays and hours, the price and the Swipe invoice stay as sold. Wrong
            plan or wrong number? Delete this one and sell it again.
          </p>

          {error && <p className="px-1 text-sm font-bold text-coral">{error}</p>}

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="flex-1 rounded-full bg-white py-3 text-base font-black text-ink transition-all active:translate-y-0.5 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 rounded-full bg-coral py-3 text-base font-black text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed disabled:opacity-40 disabled:shadow-none"
            >
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
