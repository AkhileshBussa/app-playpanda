"use client";

import { useEffect, useRef, useState } from "react";
import {
  computeQuote,
  EXTRA_ADULT,
  formatInr,
  PACKAGES,
  SOCKS,
  type PackageId,
} from "@/lib/pricing";
import { PAYMENT_METHODS, type PaymentMethod } from "@/lib/billing/types";
import StepperIcon from "@/components/StepperIcon";

interface NewBookingSheetProps {
  onClose: () => void;
  /** A booking landed — refresh the board so its card appears. */
  onCreated: () => void;
}

interface Created {
  invoiceNumber: string;
  total: number;
  paid: boolean;
  method?: PaymentMethod;
  warning?: string;
}

/**
 * Book a walk-in at the counter.
 *
 * The same choices the customer gets on the booking form, and priced by the same
 * catalogue — but laid out for someone doing this with a family waiting at the
 * desk: no explanatory copy, no scrolling past cards, steppers and pills close
 * enough together to work with one hand on a tablet.
 *
 * Payment is part of the same action when the money has already been taken,
 * because at the counter it usually has. "Pay later" leaves the invoice unpaid
 * and the card's own Collect button handles it, exactly like a family who booked
 * on the app and chose to pay at the desk.
 */
export default function NewBookingSheet({ onClose, onCreated }: NewBookingSheetProps) {
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [kidNames, setKidNames] = useState("");
  const [packageId, setPackageId] = useState<PackageId>("2hr");
  const [kids, setKids] = useState(1);
  const [extraAdults, setExtraAdults] = useState(0);
  const [childSocks, setChildSocks] = useState(0);
  const [adultSocks, setAdultSocks] = useState(0);
  const [paidNow, setPaidNow] = useState(true);
  const [method, setMethod] = useState<PaymentMethod>("UPI");
  const [reference, setReference] = useState("");

  const [known, setKnown] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);

  // Never overwrite what the manager has typed themselves.
  const nameTouched = useRef(false);
  const kidNamesTouched = useRef(false);
  const phoneRef = useRef<HTMLInputElement>(null);

  const quote = computeQuote({ packageId, kids, extraAdults, childSocks, adultSocks });
  const validPhone = /^[6-9]\d{9}$/.test(phone);
  const valid = validPhone && name.trim().length >= 2;

  useEffect(() => {
    phoneRef.current?.focus();
  }, []);

  /**
   * Look the number up as it's typed. This is what stops a regular family
   * getting a second customer record: the invoice goes to the party the phone
   * already belongs to (the server re-checks), and the manager can see that it
   * did before they commit.
   */
  useEffect(() => {
    if (!validPhone) {
      setKnown(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/customer/lookup?phone=${phone}`);
        const data = await res.json();
        if (cancelled || !data.found) return;
        setKnown(typeof data.name === "string" ? data.name : "");
        if (!nameTouched.current && data.name) setName(data.name);
        if (!kidNamesTouched.current && Array.isArray(data.kidNames) && data.kidNames.length) {
          setKidNames(data.kidNames.join(", "));
        }
      } catch {
        // Prefill is a nicety; a counter booking must never wait on it.
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [phone, validPhone]);

  const reset = () => {
    setPhone("");
    setName("");
    setKidNames("");
    setPackageId("2hr");
    setKids(1);
    setExtraAdults(0);
    setChildSocks(0);
    setAdultSocks(0);
    setReference("");
    setKnown(null);
    setCreated(null);
    nameTouched.current = false;
    kidNamesTouched.current = false;
    phoneRef.current?.focus();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving || !valid) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/ops/booking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          phone,
          packageId,
          kids,
          extraAdults,
          childSocks,
          adultSocks,
          kidNames: kidNames.split(",").map((n) => n.trim()).filter(Boolean),
          paid: paidNow,
          ...(paidNow ? { method, transactionRef: reference.trim() || undefined } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        window.location.reload();
        return;
      }
      // 207: the invoice exists but the payment didn't record — that has to be
      // said out loud, not swallowed into a success message.
      if (!res.ok && res.status !== 207) throw new Error(data.error || "Couldn't create the booking");
      setCreated({
        invoiceNumber: data.invoiceNumber,
        total: data.total ?? quote.total,
        paid: Boolean(data.paid),
        method: paidNow ? method : undefined,
        warning: data.warning,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the booking");
    } finally {
      setSaving(false);
    }
  };

  const label = "mb-1 block px-1 text-xs font-black uppercase tracking-widest text-ink/50";
  const field =
    "w-full rounded-2xl border-2 border-ink/10 bg-white px-4 py-2.5 text-base font-bold text-ink outline-none placeholder:font-bold placeholder:text-ink/30 focus:border-coral";

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-ink/40" onClick={saving ? undefined : onClose} />

      <div className="relative mx-4 max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-t-chunk bg-cream p-5 shadow-chunk sm:rounded-chunk">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-xl font-black text-ink">
            {created ? "Booked" : "New booking"}
          </h2>
          <button
            onClick={onClose}
            disabled={saving}
            className="text-2xl leading-none text-ink/40 hover:text-ink disabled:opacity-40"
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        {created ? (
          // Back-to-back families are the norm at the counter, so finishing one
          // booking offers the next rather than just closing.
          <div>
            <div className="rounded-2xl bg-green/15 px-4 py-3">
              <p className="text-base font-black text-green">
                {created.invoiceNumber} · {formatInr(created.total)}
              </p>
              <p className="mt-0.5 text-sm font-bold text-ink/60">
                {created.paid
                  ? `Paid by ${created.method} — recorded in Swipe`
                  : "Unpaid — collect it from the card"}
              </p>
            </div>
            {created.warning && (
              <p className="mt-2 rounded-2xl bg-coral/10 px-4 py-3 text-sm font-bold text-coral">
                {created.warning}
              </p>
            )}
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={reset}
                className="flex-1 rounded-full bg-white py-3 text-base font-black text-ink shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed"
              >
                Book another
              </button>
              <button
                type="button"
                onClick={onClose}
                className="flex-1 rounded-full bg-ink py-3 text-base font-black text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3.5">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={label} htmlFor="nb-phone">
                  Mobile
                </label>
                <input
                  id="nb-phone"
                  ref={phoneRef}
                  type="tel"
                  inputMode="numeric"
                  value={phone}
                  onChange={(e) => {
                    setPhone(e.target.value.replace(/\D/g, "").slice(0, 10));
                    if (error) setError(null);
                  }}
                  placeholder="10 digits"
                  className={`${field} tracking-wide`}
                />
              </div>
              <div>
                <label className={label} htmlFor="nb-name">
                  Name
                </label>
                <input
                  id="nb-name"
                  type="text"
                  value={name}
                  onChange={(e) => {
                    nameTouched.current = true;
                    setName(e.target.value);
                    if (error) setError(null);
                  }}
                  placeholder="Parent's name"
                  className={field}
                />
              </div>
            </div>

            {known !== null && (
              <p className="px-1 text-xs font-black text-green">
                {known ? `Existing customer — ${known}` : "Existing customer"} · no new record
                will be made
              </p>
            )}

            <div>
              <label className={label}>Session</label>
              <div className="flex gap-2">
                {PACKAGES.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setPackageId(p.id)}
                    className={`flex h-12 flex-1 flex-col items-center justify-center rounded-2xl text-sm font-black leading-tight transition-colors ${
                      packageId === p.id ? "bg-ink text-cream" : "bg-white text-ink/60 hover:bg-ink/10"
                    }`}
                  >
                    <span>{p.hours} hr</span>
                    <span className="text-xs font-bold opacity-70">₹{p.pricePerKid}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <CounterStepper label="Kids" value={kids} min={1} max={15} onChange={setKids} />
              <CounterStepper
                label={`Extra adults · ₹${EXTRA_ADULT.price}`}
                value={extraAdults}
                min={0}
                max={20}
                onChange={setExtraAdults}
              />
              <CounterStepper
                label={`Kids socks · ₹${SOCKS.child.price}`}
                value={childSocks}
                min={0}
                max={30}
                onChange={setChildSocks}
              />
              <CounterStepper
                label={`Adult socks · ₹${SOCKS.adult.price}`}
                value={adultSocks}
                min={0}
                max={30}
                onChange={setAdultSocks}
              />
            </div>

            <div>
              <label className={label} htmlFor="nb-kid-names">
                Kids&apos; names (optional)
              </label>
              <input
                id="nb-kid-names"
                type="text"
                value={kidNames}
                onChange={(e) => {
                  kidNamesTouched.current = true;
                  setKidNames(e.target.value);
                }}
                placeholder="Aarav, Diya"
                className={field}
              />
            </div>

            <div>
              <label className={label}>Payment</label>
              <div className="flex gap-2">
                {(
                  [
                    [true, "Paid now"],
                    [false, "Pay later"],
                  ] as const
                ).map(([value, text]) => (
                  <button
                    key={text}
                    type="button"
                    onClick={() => setPaidNow(value)}
                    className={`h-11 flex-1 rounded-full text-sm font-black leading-none transition-colors ${
                      paidNow === value ? "bg-ink text-cream" : "bg-white text-ink/60 hover:bg-ink/10"
                    }`}
                  >
                    {text}
                  </button>
                ))}
              </div>
              {paidNow ? (
                <div className="mt-2 space-y-2">
                  <div className="flex gap-2">
                    {PAYMENT_METHODS.map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setMethod(m)}
                        className={`h-10 flex-1 rounded-full text-sm font-black leading-none transition-colors ${
                          method === m ? "bg-green text-cream" : "bg-white text-ink/60 hover:bg-ink/10"
                        }`}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                  <input
                    type="text"
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                    placeholder="UPI / card reference (optional)"
                    className={field}
                  />
                </div>
              ) : (
                <p className="mt-1 px-1 text-xs font-bold text-ink/50">
                  The card will show {formatInr(quote.total)} due, with a Collect button.
                </p>
              )}
            </div>

            {error && <p className="px-1 text-sm font-bold text-coral">{error}</p>}

            <div className="flex items-center gap-3 border-t-2 border-dashed border-ink/10 pt-3">
              <div>
                <div className="text-[11px] font-black uppercase tracking-widest text-ink/50">
                  Total
                </div>
                <div className="text-2xl font-black leading-tight text-ink">
                  {formatInr(quote.total)}
                </div>
              </div>
              <button
                type="submit"
                disabled={saving || !valid}
                className={`ml-auto flex-1 rounded-full py-3.5 text-base font-black text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed disabled:opacity-40 disabled:shadow-none ${
                  paidNow ? "bg-green" : "bg-coral"
                }`}
              >
                {saving
                  ? "Booking…"
                  : paidNow
                    ? `Book & take ${formatInr(quote.total)}`
                    : "Book, pay at counter"}
              </button>
            </div>
            {!valid && (
              <p className="px-1 text-center text-xs font-bold text-ink/40">
                Mobile number and name are needed to bill it to the right customer.
              </p>
            )}
          </form>
        )}
      </div>
    </div>
  );
}

/** Label above, −/+ either side of the number: readable at a glance on a tablet.
 *  Exported for the edit sheet, which lays out the same selection. */
export function CounterStepper({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="rounded-2xl bg-white px-3 py-2">
      <div className="truncate text-xs font-black uppercase tracking-wide text-ink/50">{label}</div>
      <div className="mt-1 flex items-center justify-between">
        <button
          type="button"
          aria-label={`Decrease ${label}`}
          onClick={() => onChange(Math.max(min, value - 1))}
          disabled={value <= min}
          className="grid h-9 w-9 place-items-center rounded-full bg-cream text-ink transition-transform active:translate-y-[1px] disabled:opacity-30"
        >
          <StepperIcon kind="minus" />
        </button>
        <span className="text-xl font-black tabular-nums text-ink">{value}</span>
        <button
          type="button"
          aria-label={`Increase ${label}`}
          onClick={() => onChange(Math.min(max, value + 1))}
          disabled={value >= max}
          className="grid h-9 w-9 place-items-center rounded-full bg-green text-cream transition-transform active:translate-y-[1px] disabled:opacity-30"
        >
          <StepperIcon kind="plus" />
        </button>
      </div>
    </div>
  );
}
