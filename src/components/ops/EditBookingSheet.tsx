"use client";

import { useEffect, useState } from "react";
import {
  computeQuote,
  EXTRA_30_MIN,
  EXTRA_ADULT,
  formatInr,
  PACKAGES,
  SOCKS,
  type PackageId,
} from "@/lib/pricing";
import type { OpsSession } from "@/lib/ops/types";
import { CounterStepper } from "./NewBookingSheet";

interface EditBookingSheetProps {
  session: OpsSession;
  onClose: () => void;
  /** The edit landed; carries the new balance so the card can update. */
  onSaved: (session: OpsSession, amountDue: number) => void;
}

/**
 * Edit a booking after it's made — the same choices as the creation sheet,
 * reopened over the invoice that already exists: wrong package, another kid
 * joining, a typo'd name or phone, socks added at the gate.
 *
 * The customer fields prefill instantly from the card; the selection prefills
 * from the invoice itself (the card doesn't know its socks from its adults),
 * and the same read says up front when this booking can't be edited here —
 * discounted, shared, or built by hand in Swipe — so nobody retypes a form
 * that was never going to save.
 *
 * Payment is the one creation-card section missing on purpose: money already
 * taken stays attached to the invoice, whatever the new total leaves owing
 * shows on the card with its usual Collect button, and pricing the booking
 * below what's been collected is refused rather than turned into a refund.
 */
export default function EditBookingSheet({ session, onClose, onSaved }: EditBookingSheetProps) {
  // Swipe hands phones back in assorted shapes; the last 10 digits are the
  // mobile number the form (and the lookup) understand.
  const originalPhone = session.phone.replace(/\D/g, "").slice(-10);
  const [phone, setPhone] = useState(originalPhone);
  const [name, setName] = useState(session.parentName);
  const [kidNames, setKidNames] = useState(session.kidNames.join(", "));
  const [packageId, setPackageId] = useState<PackageId>("2hr");
  const [kids, setKids] = useState(1);
  const [extraAdults, setExtraAdults] = useState(0);
  const [childSocks, setChildSocks] = useState(0);
  const [adultSocks, setAdultSocks] = useState(0);
  const [extra30, setExtra30] = useState(0);

  const [loading, setLoading] = useState(true);
  /** Refusal copy when this booking can't be edited from the board. */
  const [blocked, setBlocked] = useState<string | null>(null);
  /** ₹ already taken against this invoice — the floor under any new total. */
  const [collected, setCollected] = useState(0);
  /** Who a changed number belongs to, so re-billing is seen before it's saved. */
  const [known, setKnown] = useState<{ found: boolean; name: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const quote = computeQuote({ packageId, kids, extraAdults, childSocks, adultSocks, extra30 });
  const validPhone = /^[6-9]\d{9}$/.test(phone);
  const belowFloor = quote.total + 0.005 < collected;
  const valid = validPhone && name.trim().length >= 2 && !belowFloor;

  // The selection comes from the invoice, not the board: the card knows its
  // play line but not its socks or extra adults. The same read refuses edits
  // that couldn't land (discounted, shared, hand-built) before anyone types.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/ops/booking?id=${encodeURIComponent(session.id)}`);
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.status === 401) {
          window.location.reload();
          return;
        }
        if (!res.ok) throw new Error(data.error || "Couldn't read the booking");
        if (!data.editable) {
          setBlocked(data.reason || "This booking can't be edited from here.");
          return;
        }
        setPackageId(data.selection.packageId);
        setKids(data.selection.kids);
        setExtraAdults(data.selection.extraAdults);
        setChildSocks(data.selection.childSocks);
        setAdultSocks(data.selection.adultSocks);
        setExtra30(data.selection.extra30 ?? 0);
        setCollected(Math.max(0, Number(data.total ?? 0) - Number(data.amountDue ?? 0)));
      } catch (err) {
        if (!cancelled) {
          setBlocked(err instanceof Error ? err.message : "Couldn't read the booking");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session.id]);

  // A changed number re-bills the invoice to whoever owns it, so say who that
  // is (or that a new record will be made) before Save commits to it. Display
  // only — nothing is prefilled from it, this booking's details stay as typed.
  useEffect(() => {
    if (!validPhone || phone === originalPhone) {
      setKnown(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/customer/lookup?phone=${phone}`);
        const data = await res.json();
        if (cancelled) return;
        setKnown({ found: Boolean(data.found), name: typeof data.name === "string" ? data.name : "" });
      } catch {
        // The hint is a nicety; the server re-resolves the party either way.
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [phone, validPhone, originalPhone]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving || !valid) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/ops/booking", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: session.id,
          name: name.trim(),
          phone,
          packageId,
          kids,
          extraAdults,
          childSocks,
          adultSocks,
          extra30,
          kidNames: kidNames.split(",").map((n) => n.trim()).filter(Boolean),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        window.location.reload();
        return;
      }
      if (!res.ok) throw new Error(data.error || "Couldn't save the changes");
      onSaved(session, Number(data.amountDue ?? quote.total));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the changes");
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
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-xl font-black text-ink">Edit booking</h2>
          <button
            onClick={onClose}
            disabled={saving}
            className="text-2xl leading-none text-ink/40 hover:text-ink disabled:opacity-40"
            aria-label="Close"
          >
            &times;
          </button>
        </div>
        <p className="mb-3 text-sm font-bold text-ink/60">
          {session.invoiceNumber}
          {collected > 0 && ` · ${formatInr(collected)} already collected`}
        </p>

        {loading ? (
          <div className="py-10 text-center">
            <div className="inline-block h-6 w-6 animate-spin rounded-full border-4 border-ink/15 border-t-coral" />
            <p className="mt-3 text-sm font-bold text-ink/50">Reading the invoice…</p>
          </div>
        ) : blocked ? (
          <div>
            <p className="rounded-2xl bg-coral/10 px-4 py-3 text-sm font-bold text-coral">
              {blocked}
            </p>
            <button
              type="button"
              onClick={onClose}
              className="mt-4 w-full rounded-full bg-ink py-3 text-base font-black text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed"
            >
              Close
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3.5">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={label} htmlFor="eb-phone">
                  Mobile
                </label>
                <input
                  id="eb-phone"
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
                <label className={label} htmlFor="eb-name">
                  Name
                </label>
                <input
                  id="eb-name"
                  type="text"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    if (error) setError(null);
                  }}
                  placeholder="Parent's name"
                  className={field}
                />
              </div>
            </div>

            {known !== null && (
              <p className={`px-1 text-xs font-black ${known.found ? "text-green" : "text-coral"}`}>
                {known.found
                  ? `${known.name ? `Existing customer — ${known.name}` : "Existing customer"} · the bill moves to them`
                  : "New number — a fresh customer record will be made"}
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

            {/* Extra time is the reason most bookings get edited at all — a
                family already inside asking to stay on — so it gets its own
                row rather than a fifth cell in the add-ons grid.

                One block is half an hour for ONE kid: the board splits the
                invoice's extra minutes across the kids on it. The line under
                the stepper does that arithmetic so nobody has to. */}
            <div>
              <CounterStepper
                label={`${EXTRA_30_MIN.label} · ₹${EXTRA_30_MIN.price} each`}
                value={extra30}
                min={0}
                max={20}
                onChange={setExtra30}
              />
              <p className="mt-1 px-1 text-xs font-bold text-ink/40">
                {extra30 === 0
                  ? `One block is 30 min for one kid — ${kids} block${kids > 1 ? "s" : ""} adds half an hour to this booking.`
                  : `Adds ${Math.round((extra30 / kids) * 30)} min to each kid's session.`}
              </p>
            </div>

            <div>
              <label className={label} htmlFor="eb-kid-names">
                Kids&apos; names (optional)
              </label>
              <input
                id="eb-kid-names"
                type="text"
                value={kidNames}
                onChange={(e) => setKidNames(e.target.value)}
                placeholder="Aarav, Diya"
                className={field}
              />
            </div>

            {error && <p className="px-1 text-sm font-bold text-coral">{error}</p>}

            <div className="flex items-center gap-3 border-t-2 border-dashed border-ink/10 pt-3">
              <div>
                <div className="text-[11px] font-black uppercase tracking-widest text-ink/50">
                  New total
                </div>
                <div className="text-2xl font-black leading-tight text-ink">
                  {formatInr(quote.total)}
                </div>
              </div>
              <button
                type="submit"
                disabled={saving || !valid}
                className="ml-auto flex-1 rounded-full bg-coral py-3.5 text-base font-black text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed disabled:opacity-40 disabled:shadow-none"
              >
                {saving ? "Saving…" : "Save changes"}
              </button>
            </div>
            {/* One line on what saving does to the money, since that's the only
                part of an edit that isn't visible in the fields themselves. */}
            <p
              className={`px-1 text-center text-xs font-bold ${
                belowFloor ? "text-coral" : "text-ink/40"
              }`}
            >
              {belowFloor
                ? `${formatInr(collected)} has already been collected — the total can't go below it.`
                : !validPhone || name.trim().length < 2
                  ? "Mobile number and name are needed to bill it to the right customer."
                  : collected > 0
                    ? quote.total - collected > 0.005
                      ? `${formatInr(quote.total - collected)} left to collect after saving.`
                      : "Fully paid after saving."
                    : `The card will show ${formatInr(quote.total)} due.`}
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
