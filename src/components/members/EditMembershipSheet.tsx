"use client";

import { useState } from "react";
import type { Membership } from "@/lib/members/types";
import { addMonths, getPlan, MEMBERSHIP_PLANS, PUNCH_PRODUCTS } from "@/lib/members/plans";
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

const chip = (on: boolean) =>
  `rounded-full px-4 py-2 text-sm font-black transition-all ${
    on ? "bg-coral text-cream shadow-btn" : "bg-white text-ink/60"
  }`;

/**
 * Fix a membership after it was sold: the names on it, which plan it is, its
 * terms and dates, when it's recorded under, and how the sale was paid.
 *
 * Money stays out: the price and the Swipe sale invoice are exactly as billed.
 * "Paid by" is the one money-adjacent field, and it corrects our ledger only —
 * the sheet says so, and the server repeats it in the reply.
 */
export default function EditMembershipSheet({
  membership,
  onClose,
  onSaved,
}: EditMembershipSheetProps) {
  const [customerName, setCustomerName] = useState(membership.customerName);
  const [kidNames, setKidNames] = useState(membership.kidNames);
  const [planKey, setPlanKey] = useState(membership.planKey);
  const [planName, setPlanName] = useState(membership.planName);
  const [punchProductId, setPunchProductId] = useState(membership.punchProductId);
  const [unlimited, setUnlimited] = useState(membership.totalPlays == null);
  const [totalPlays, setTotalPlays] = useState(String(membership.totalPlays ?? ""));
  const [hoursPerPlay, setHoursPerPlay] = useState(String(membership.hoursPerPlay));
  const [kidsPerPlay, setKidsPerPlay] = useState(String(membership.kidsPerPlay));
  const [weekdaysOnly, setWeekdaysOnly] = useState(membership.weekdaysOnly);
  const [startsOn, setStartsOn] = useState(membership.startsOn);
  const [expiresOn, setExpiresOn] = useState(membership.expiresOn);
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

  const isCustom = planKey === "custom";
  const canEditPaidBy = membership.salePaymentId != null;

  const selectPlan = (key: string) => {
    setPlanKey(key);
    const plan = getPlan(key);
    if (!plan) {
      setPlanName(membership.planKey === "custom" ? membership.planName : "");
      return;
    }
    setPlanName(plan.name);
    setPunchProductId(plan.punchProductId);
    setUnlimited(plan.totalPlays == null);
    setTotalPlays(String(plan.totalPlays ?? ""));
    setHoursPerPlay(String(plan.hoursPerPlay));
    setKidsPerPlay(String(plan.kidsPerPlay));
    setWeekdaysOnly(plan.weekdaysOnly);
    if (/^\d{4}-\d{2}-\d{2}$/.test(startsOn)) {
      setExpiresOn(addMonths(startsOn, plan.validityMonths));
    }
  };

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
          planKey,
          planName: planName.trim(),
          punchProductId,
          totalPlays: unlimited ? null : parseInt(totalPlays) || 0,
          hoursPerPlay: parseFloat(hoursPerPlay) || 0,
          kidsPerPlay: parseInt(kidsPerPlay) || 1,
          weekdaysOnly,
          oncePerDay: unlimited,
          startsOn,
          expiresOn,
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
          {membership.phone}
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
            <label className={labelClass}>Plan</label>
            <div className="flex flex-wrap gap-1.5">
              {MEMBERSHIP_PLANS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => selectPlan(p.key)}
                  className={chip(planKey === p.key)}
                >
                  {p.name}
                </button>
              ))}
              <button type="button" onClick={() => selectPlan("custom")} className={chip(isCustom)}>
                Custom
              </button>
            </div>
          </div>

          {isCustom && (
            <>
              <div>
                <label className={labelClass}>Custom plan name *</label>
                <input
                  type="text"
                  value={planName}
                  onChange={(e) => setPlanName(e.target.value)}
                  placeholder="e.g. Summer Camp Pass"
                  className={inputClass}
                  required
                />
              </div>
              <div>
                <label className={labelClass}>Punches bill against</label>
                <select
                  value={punchProductId}
                  onChange={(e) => setPunchProductId(Number(e.target.value))}
                  className={inputClass}
                >
                  {PUNCH_PRODUCTS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}

          <div>
            <label className={labelClass}>Plays</label>
            <div className="flex gap-2">
              <input
                type="number"
                min={1}
                value={unlimited ? "" : totalPlays}
                onChange={(e) => setTotalPlays(e.target.value)}
                disabled={unlimited}
                placeholder={unlimited ? "Unlimited" : "e.g. 10"}
                className={`${inputClass} flex-1 disabled:opacity-50`}
              />
              <button
                type="button"
                onClick={() => setUnlimited((u) => !u)}
                className={chip(unlimited)}
              >
                Unlimited
              </button>
            </div>
            <p className="mt-1 px-1 text-xs font-bold text-ink/40">
              {membership.playsUsed} play{membership.playsUsed === 1 ? "" : "s"} already punched —
              the total can&apos;t go below that.
            </p>
          </div>

          <div className="flex gap-2">
            <div className="flex-1">
              <label className={labelClass}>Hours/play</label>
              <input
                type="number"
                step="0.5"
                min={0.5}
                value={hoursPerPlay}
                onChange={(e) => setHoursPerPlay(e.target.value)}
                className={inputClass}
              />
            </div>
            <div className="flex-1">
              <label className={labelClass}>Kids/play</label>
              <input
                type="number"
                min={1}
                value={kidsPerPlay}
                onChange={(e) => setKidsPerPlay(e.target.value)}
                className={inputClass}
              />
            </div>
          </div>

          <button
            type="button"
            onClick={() => setWeekdaysOnly((w) => !w)}
            className={chip(weekdaysOnly)}
          >
            Mon–Fri only
          </button>

          <div className="flex gap-2">
            <div className="flex-1">
              <label className={labelClass}>Starts on</label>
              <input
                type="date"
                value={startsOn}
                onChange={(e) => setStartsOn(e.target.value)}
                className={inputClass}
              />
            </div>
            <div className="flex-1">
              <label className={labelClass}>Expires on</label>
              <input
                type="date"
                value={expiresOn}
                min={startsOn}
                onChange={(e) => setExpiresOn(e.target.value)}
                className={inputClass}
              />
            </div>
          </div>

          <div>
            <label className={labelClass}>Recorded on</label>
            <input
              type="date"
              value={createdOn}
              max={todayIST()}
              onChange={(e) => setCreatedOn(e.target.value)}
              className={inputClass}
            />
            <p className="mt-1 px-1 text-xs font-bold text-ink/40">
              Which day this membership sits under in the ledger. The Swipe invoice keeps its
              own date.
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
            The price and the Swipe sale invoice aren&apos;t touched. The phone number can&apos;t
            change here — a membership on the wrong number is a delete and a fresh sale.
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
