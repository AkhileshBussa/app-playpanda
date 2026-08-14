"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import {
  applyDiscount,
  computeQuote,
  EXTRA_ADULT,
  formatInr,
  PACKAGES,
  SOCKS,
  type AppliedDiscount,
  type PackageId,
} from "@/lib/pricing";
import { HEARD_FROM_SOURCES } from "@/lib/heardFrom";
import { CUSTOMER_CODES_ENABLED } from "@/lib/discounts/enabled";

const inr = formatInr;

// Kill switch for online payment: set NEXT_PUBLIC_PAYMENTS_ENABLED="false" to
// fall back to book-now-pay-at-counter (e.g. if the gateway misbehaves).
const PAYMENTS_ENABLED = process.env.NEXT_PUBLIC_PAYMENTS_ENABLED !== "false";

/** Razorpay order created by the billing backend's connected gateway. */
interface PaymentOrder {
  orderId: string;
  keyId: string;
  /** Paise. */
  amountMinor: number;
  currency: string;
}

interface CheckoutResponse {
  invoiceNumber: string;
  /** Opaque billing-backend handle (used later to record payment). */
  ref: string;
  total: number;
  skipPayment?: boolean;
  payment?: PaymentOrder | null;
}

type Status = "idle" | "booking" | "paying" | "verifying";

// ── Razorpay checkout.js ─────────────────────────────────────────────────────

interface RazorpaySuccess {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

interface RazorpayOptions {
  key: string;
  /** Paise, as a string (checkout.js convention). */
  amount: string;
  currency: string;
  name: string;
  description?: string;
  order_id: string;
  prefill?: { name?: string; contact?: string };
  notes?: Record<string, string>;
  theme?: { color?: string };
  handler: (response: RazorpaySuccess) => void;
  modal?: { ondismiss?: () => void };
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => { open: () => void };
  }
}

let razorpayScript: Promise<boolean> | null = null;

/** Load checkout.js once; resolves false (never rejects) when offline. */
function loadRazorpay(): Promise<boolean> {
  if (typeof window !== "undefined" && window.Razorpay) return Promise.resolve(true);
  if (!razorpayScript) {
    razorpayScript = new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = "https://checkout.razorpay.com/v1/checkout.js";
      script.onload = () => resolve(true);
      script.onerror = () => {
        razorpayScript = null; // allow a retry on the next attempt
        resolve(false);
      };
      document.body.appendChild(script);
    });
  }
  return razorpayScript;
}

export default function BookingForm() {
  const router = useRouter();

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [kids, setKids] = useState(1);
  const [packageId, setPackageId] = useState<PackageId>("2hr");
  const [extraAdults, setExtraAdults] = useState(0);
  const [kidNames, setKidNames] = useState("");
  const [childSocks, setChildSocks] = useState(0);
  const [adultSocks, setAdultSocks] = useState(0);
  const nameTouched = useRef(false);
  const kidNamesTouched = useRef(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const [status, setStatus] = useState<Status>("idle");
  // Which of the two equally-weighted buttons was tapped, so each shows its own
  // busy label instead of both claiming the booking.
  const [flow, setFlow] = useState<"online" | "counter">("online");
  const [error, setError] = useState<string | null>(null);
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [welcomeBack, setWelcomeBack] = useState<string | null>(null);
  // True only once the lookup has said to ask — a genuinely new family that
  // hasn't answered "how did you hear about us?" before. The server decides
  // (it can see both the billing backend and our customer records).
  const [askHeardFrom, setAskHeardFrom] = useState(false);
  const [heardFrom, setHeardFrom] = useState<string[]>([]);
  // Discount code. `applied` is what the SERVER priced — the client only ever
  // re-displays it, and /api/checkout re-checks it before the invoice is made.
  const [codeInput, setCodeInput] = useState("");
  const [applied, setApplied] = useState<AppliedDiscount | null>(null);
  const [codeBusy, setCodeBusy] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);

  const canSubmit = name.trim().length >= 2 && /^[6-9]\d{9}$/.test(phone);

  // Returning customers: on a valid phone, prefill name + kids' names from
  // Swipe (their Child N custom fields). Debounced, silent on failure, and
  // never overwrites anything the customer has already typed.
  useEffect(() => {
    if (!/^[6-9]\d{9}$/.test(phone)) {
      setWelcomeBack(null);
      setAskHeardFrom(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/customer/lookup?phone=${phone}`);
        const data = await res.json();
        if (cancelled) return;
        setAskHeardFrom(Boolean(data.askHeardFrom));
        if (!data.found) {
          // Clear any welcome-back note left by a previously typed number.
          setWelcomeBack(null);
          return;
        }
        setWelcomeBack(typeof data.name === "string" ? data.name : "");
        if (!nameTouched.current && data.name) setName(data.name);
        if (!kidNamesTouched.current && Array.isArray(data.kidNames) && data.kidNames.length) {
          setKidNames(data.kidNames.join(", "));
        }
      } catch {
        // prefill is a nicety — ignore failures
      }
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [phone]);

  // Preload the Razorpay SDK so the payment sheet opens instantly on tap.
  useEffect(() => {
    if (PAYMENTS_ENABLED) void loadRazorpay();
  }, []);

  // Re-submitting the same selection reuses the created invoice instead of
  // creating a duplicate in Swipe.
  const checkoutCache = useRef<{ key: string; data: CheckoutResponse } | null>(null);

  // Re-entrancy guard: `disabled={busy}` relies on a re-render, so a double
  // tap (or touchend + click both firing) could otherwise create two invoices.
  const payInFlight = useRef(false);
  // Distinguishes a tap from a scroll that starts on the button.
  const touchMoved = useRef(false);

  const baseQuote = useMemo(
    () => computeQuote({ packageId, kids, extraAdults, childSocks, adultSocks }),
    [packageId, kids, extraAdults, childSocks, adultSocks]
  );
  // Everything downstream — the sticky total, the breakdown, the pay button —
  // reads this, so there's one number and it's always the one being charged.
  const quote = useMemo(
    () => (applied ? applyDiscount(baseQuote, applied) : baseQuote),
    [baseQuote, applied]
  );

  /**
   * Ask the server what a code is worth. Nothing is redeemed by this — it's the
   * live preview, and the code is only spent when the booking is created.
   */
  const checkCode = async (raw: string, opts?: { silent?: boolean }) => {
    const code = raw.trim().toUpperCase();
    if (!code) return;
    if (!/^[6-9]\d{9}$/.test(phone)) {
      setCodeError("Enter your mobile number first");
      return;
    }
    if (!opts?.silent) setCodeBusy(true);
    try {
      const res = await fetch("/api/discounts/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          phone,
          packageId,
          kids,
          extraAdults,
          childSocks,
          adultSocks,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setApplied(null);
        setCodeError(data.error || "That code isn't valid");
        return;
      }
      setApplied({ code: data.code, amount: data.amount });
      setCodeError(null);
    } catch {
      // Offline or the check failed — never block the booking over a code.
      if (!opts?.silent) setCodeError("Couldn't check that code right now");
    } finally {
      setCodeBusy(false);
    }
  };

  // A percentage is worth a different amount once the family adds a kid or a
  // pair of socks, so an applied code is re-priced whenever the selection moves.
  // Silent: this is a correction, not something the customer asked for.
  const appliedCodeName = applied?.code;
  useEffect(() => {
    if (!appliedCodeName) return;
    void checkCode(appliedCodeName, { silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedCodeName, baseQuote.total]);

  const pay = async (payOnline = true) => {
    // Button looks disabled until the form is valid but stays clickable, so a
    // tap surfaces the tip (and jumps to the field that needs filling).
    if (name.trim().length < 2) {
      setError("Please enter your name");
      nameInputRef.current?.focus();
      return;
    }
    if (!/^[6-9]\d{9}$/.test(phone)) {
      setError("Please enter a valid 10-digit mobile number");
      return;
    }
    if (payInFlight.current) return;
    payInFlight.current = true;
    setError(null);
    setFlow(payOnline ? "online" : "counter");
    setStatus("booking");

    try {
      const payload = {
        name: name.trim(),
        phone,
        packageId,
        kids,
        extraAdults,
        childSocks,
        adultSocks,
        kidNames: kidNames.split(",").map((n) => n.trim()).filter(Boolean),
        ...(askHeardFrom && heardFrom.length ? { heardFrom } : {}),
        // The server re-checks and spends the code; the amount above is only
        // ever what the customer was shown.
        ...(applied ? { discountCode: applied.code } : {}),
      };
      // The key deliberately excludes payNow: whichever button was tapped, the
      // same selection must reuse the same invoice, never create a second one.
      const cacheKey = JSON.stringify(payload);

      let checkout = checkoutCache.current?.key === cacheKey ? checkoutCache.current.data : null;
      if (!checkout) {
        const res = await fetch("/api/checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, payNow: payOnline }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Something went wrong");
        checkout = data as CheckoutResponse;
        checkoutCache.current = { key: cacheKey, data: checkout };
      }

      // Invoice created in Swipe. The confirmation screen is keyed by the
      // invoice number (without prefix) and fetches everything from the backend.
      const number = checkout.invoiceNumber.replace(/^\D+/, "");
      const goSuccess = () => router.push(`/success/${encodeURIComponent(number)}`);

      const order = checkout.payment;
      if (!payOnline || checkout.skipPayment || !order) {
        goSuccess();
        return;
      }

      // Online payment: the booking is already saved, so every failure path
      // from here lands on the confirmation screen (unpaid → pay at counter).
      if (!(await loadRazorpay()) || !window.Razorpay) {
        goSuccess();
        return;
      }

      const { ref } = checkout;
      setStatus("paying");
      new window.Razorpay({
        key: order.keyId,
        amount: String(order.amountMinor),
        currency: order.currency,
        name: "Play Panda",
        description: "Play session booking",
        order_id: order.orderId,
        prefill: { name: name.trim(), contact: phone },
        notes: { invoice: checkout.invoiceNumber },
        theme: { color: "#FF613A" },
        handler: async (rzp) => {
          // Paid. Ask the backend to verify the signature and mark the invoice
          // paid; even if that fails, the money is collected — proceed to the
          // confirmation screen rather than alarming the customer.
          setStatus("verifying");
          try {
            await fetch("/api/payment/verify", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                ref,
                orderId: order.orderId,
                paymentId: rzp.razorpay_payment_id,
                signature: rzp.razorpay_signature,
                raw: rzp,
              }),
            });
          } catch {
            // Verified server-side on retry at the counter if needed.
          }
          goSuccess();
        },
        modal: {
          // Closed without paying — still booked; pay at the counter.
          ondismiss: goSuccess,
        },
      }).open();
    } catch (err) {
      payInFlight.current = false;
      setStatus("idle");
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    }
  };

  const busy = status !== "idle";

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col">
      {/* Header */}
      <header className="flex items-end justify-between px-5 pt-6">
        <div>
          <Image
            src="/LogoWithoutBG.png"
            alt="Play Panda"
            width={84}
            height={44}
            priority
            className="h-11 w-auto"
          />
          <h1 className="mt-1 text-[1.7rem] font-black leading-[1.05] text-ink">
            Book your play session
          </h1>
          <p className="mt-1.5 text-sm font-bold text-ink/60">
            Skip the line — book here, flash your code at the counter, jump right in.
          </p>
        </div>
        <Image
          src="/MascotWithoutBG.png"
          alt=""
          width={90}
          height={120}
          priority
          className="mb-1 h-24 w-auto shrink-0"
        />
      </header>

      <div className="flex flex-col gap-4 px-5 pb-48 pt-5">
        {/* Contact — mobile first (it prefills the name for returning families) */}
        <section className="rounded-chunk bg-white p-4 shadow-chunk">
          <input
            type="tel"
            inputMode="numeric"
            value={phone}
            onChange={(e) => {
              setPhone(e.target.value.replace(/\D/g, "").slice(0, 10));
              if (error) setError(null);
            }}
            placeholder="Mobile number"
            autoComplete="tel-national"
            className="w-full rounded-2xl border-2 border-ink/10 bg-cream/60 px-4 py-3.5 text-base font-bold tracking-wide text-ink outline-none placeholder:font-bold placeholder:text-ink/30 focus:border-coral"
          />
          <input
            ref={nameInputRef}
            type="text"
            value={name}
            onChange={(e) => {
              nameTouched.current = true;
              setName(e.target.value);
              if (error) setError(null);
            }}
            placeholder="Your name"
            autoComplete="name"
            className="mt-3 w-full rounded-2xl border-2 border-ink/10 bg-cream/60 px-4 py-3.5 text-base font-bold text-ink outline-none placeholder:font-bold placeholder:text-ink/30 focus:border-coral"
          />
          {welcomeBack !== null && (
            <div className="mt-2 px-1 text-xs font-bold text-green">
              {welcomeBack ? `Welcome back, ${welcomeBack}! 🐼` : "Welcome back! 🐼"} We&apos;ve
              filled in your details.
            </div>
          )}
        </section>

        {/* First visit only: one optional tap that tells us which marketing
            actually works. Returning families — and anyone who has already
            answered once — never see it. */}
        {askHeardFrom && (
          <section className="rounded-chunk bg-white p-4 shadow-chunk">
            <div className="text-base font-black text-ink">How did you hear about us?</div>
            <div className="text-xs font-bold text-ink/50">Optional — tap any that apply</div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {HEARD_FROM_SOURCES.map((source) => {
                const selected = heardFrom.includes(source);
                return (
                  <label
                    key={source}
                    className={`cursor-pointer rounded-full px-3.5 py-2 text-sm font-black transition-colors ${
                      selected ? "bg-green text-cream" : "bg-cream text-ink/60"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() =>
                        setHeardFrom((prev) =>
                          selected ? prev.filter((s) => s !== source) : [...prev, source]
                        )
                      }
                      className="sr-only"
                    />
                    {selected && "✓ "}
                    {source}
                  </label>
                );
              })}
            </div>
          </section>
        )}

        {/* Package — the choice that drives the price, so it comes first. */}
        <section>
          <div className="mb-2.5 px-1 text-sm font-bold uppercase tracking-widest text-coral">
            How long will they play?
          </div>
          <div className="grid grid-cols-3 gap-2.5">
            {PACKAGES.map((pkg) => {
              const selected = pkg.id === packageId;
              return (
                <button
                  key={pkg.id}
                  type="button"
                  onClick={() => setPackageId(pkg.id)}
                  className={`relative rounded-chunk p-3 pt-4 text-center transition-all duration-150 ${
                    selected
                      ? "bg-coral text-cream shadow-chunk"
                      : "bg-white text-ink shadow-chunk active:translate-y-[2px]"
                  }`}
                >
                  {pkg.popular && (
                    <span className="absolute -top-2 left-1/2 -translate-x-1/2 rounded-full bg-yellow px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-ink">
                      Popular
                    </span>
                  )}
                  <div className="text-2xl font-black">{pkg.hours}</div>
                  <div className={`text-[11px] font-bold ${selected ? "text-cream/80" : "text-ink/50"}`}>
                    hour{pkg.hours > 1 ? "s" : ""}
                  </div>
                  <div className="mt-1.5 text-sm font-black">{inr(pkg.pricePerKid)}</div>
                  <div className={`text-[10px] font-bold ${selected ? "text-cream/80" : "text-ink/40"}`}>
                    per kid
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        {/* Kids */}
        <section className="rounded-chunk bg-white p-4 shadow-chunk">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-base font-black text-ink">Kids playing</div>
              <div className="text-xs font-bold text-ink/50">Ages 1–12</div>
            </div>
            <Stepper value={kids} min={1} max={15} onChange={setKids} />
          </div>
          <input
            type="text"
            value={kidNames}
            onChange={(e) => {
              kidNamesTouched.current = true;
              setKidNames(e.target.value);
            }}
            placeholder="Kids' names (optional) — e.g. Aarav, Diya"
            className="mt-3 w-full rounded-2xl border-2 border-ink/10 bg-cream/60 px-4 py-3 text-sm font-bold text-ink outline-none placeholder:font-semibold placeholder:text-ink/30 focus:border-coral"
          />
          <div className="mt-3 flex items-center gap-2 rounded-2xl bg-green/10 px-3 py-2 text-xs font-bold text-green">
            <span>🎟️</span>
            <span>1 adult comes in free with every child.</span>
          </div>
        </section>

        {/* Extra adults */}
        <section className="flex items-center justify-between rounded-chunk bg-white p-4 shadow-chunk">
          <div className="pr-3">
            <div className="text-base font-black text-ink">Extra adults</div>
            <div className="text-xs font-bold text-ink/50">
              Only for adults beyond the free one per child · {inr(EXTRA_ADULT.price)} each
            </div>
          </div>
          <Stepper value={extraAdults} min={0} max={20} onChange={setExtraAdults} />
        </section>

        {/* Socks */}
        <section className="rounded-chunk bg-white p-4 shadow-chunk">
          <div className="flex items-center gap-2">
            <div className="text-base font-black text-ink">Socks</div>
            <span className="rounded-full bg-coral px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-cream">
              Required
            </span>
          </div>
          <div className="text-xs font-bold text-ink/50">
            Mandatory for everyone on the play floor — kids & adults. Add a pair for anyone who
            needs one (skip if you&apos;re bringing your own).
          </div>
          <div className="mt-3 flex items-center justify-between">
            <div className="text-sm font-bold text-ink">
              Kids <span className="text-ink/50">· {inr(SOCKS.child.price)}/pair</span>
            </div>
            <Stepper value={childSocks} min={0} max={30} onChange={setChildSocks} />
          </div>
          <div className="mt-3 flex items-center justify-between">
            <div className="text-sm font-bold text-ink">
              Adults <span className="text-ink/50">· {inr(SOCKS.adult.price)}/pair</span>
            </div>
            <Stepper value={adultSocks} min={0} max={30} onChange={setAdultSocks} />
          </div>
        </section>

        {/* Discount code. Deliberately last and deliberately quiet: most
            families don't have one, and a prominent empty code box makes
            everyone else feel they're paying too much.
            Behind NEXT_PUBLIC_DISCOUNT_CODES_ENABLED — the counter can still
            discount an invoice on /ops while this is off. */}
        {CUSTOMER_CODES_ENABLED && (
        <section className="rounded-chunk bg-white p-4 shadow-chunk">
          {applied ? (
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-base font-black text-green">
                  {applied.code} applied 🎉
                </div>
                <div className="text-xs font-bold text-ink/50">
                  {inr(applied.amount)} off your booking
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setApplied(null);
                  setCodeInput("");
                  setCodeError(null);
                }}
                className="shrink-0 rounded-full bg-cream px-3.5 py-2 text-sm font-black text-ink/60 transition-colors hover:bg-ink/10"
              >
                Remove
              </button>
            </div>
          ) : (
            <>
              <label
                htmlFor="discount-code"
                className="text-base font-black text-ink"
              >
                Have a discount code?
              </label>
              <div className="mt-2 flex gap-2">
                <input
                  id="discount-code"
                  type="text"
                  value={codeInput}
                  onChange={(e) => {
                    setCodeInput(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 24));
                    if (codeError) setCodeError(null);
                  }}
                  // Enter shouldn't submit anything — there's no form here, but
                  // being explicit keeps it from ever booking by accident.
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void checkCode(codeInput);
                    }
                  }}
                  placeholder="Enter code"
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  className="min-w-0 flex-1 rounded-2xl border-2 border-ink/10 bg-cream/60 px-4 py-3 text-base font-black tracking-wider text-ink outline-none placeholder:font-bold placeholder:tracking-normal placeholder:text-ink/30 focus:border-coral"
                />
                <button
                  type="button"
                  onClick={() => void checkCode(codeInput)}
                  disabled={codeBusy || codeInput.trim().length === 0}
                  className="shrink-0 rounded-full bg-ink px-5 text-sm font-black text-cream transition-all active:translate-y-[1px] disabled:opacity-30"
                >
                  {codeBusy ? "…" : "Apply"}
                </button>
              </div>
              {codeError && (
                <p className="mt-2 px-1 text-xs font-bold text-coral">{codeError}</p>
              )}
            </>
          )}
        </section>
        )}
      </div>

      {/* Sticky pay bar */}
      <div className="fixed inset-x-0 bottom-0 mx-auto w-full max-w-md border-t border-ink/5 bg-cream/95 px-5 pb-6 pt-3 backdrop-blur">
        {error && (
          <div className="mb-2 rounded-2xl bg-coral/10 px-3 py-2 text-center text-sm font-bold text-coral">
            {error}
          </div>
        )}
        {!error && !PAYMENTS_ENABLED && (
          <div className="mb-2 rounded-2xl bg-yellow/25 px-3 py-2 text-center text-xs font-bold text-ink/70">
            💡 Online payment is coming soon — book now & pay at the counter.
          </div>
        )}
        {showBreakdown && (
          <div className="mb-3 space-y-1.5 border-b border-dashed border-ink/10 pb-3">
            {/* Line prices are shown BEFORE the discount, with the saving on its
                own row — "₹699 each, ₹140 off" is what a family can check
                against the price list, where silently cheaper lines aren't. */}
            {baseQuote.lines.map((line) => (
              <div key={line.sku} className="flex justify-between text-sm font-bold text-ink/70">
                <span>
                  {line.displayName} × {line.quantity}
                </span>
                <span>{inr(line.lineTotal)}</span>
              </div>
            ))}
            {quote.discount && (
              <div className="flex justify-between text-sm font-black text-green">
                <span>{quote.discount.code}</span>
                <span>−{inr(quote.discount.amount)}</span>
              </div>
            )}
            <div className="pt-1 text-[11px] font-bold text-ink/40">Prices include GST</div>
          </div>
        )}
        <button
          type="button"
          onClick={() => setShowBreakdown((v) => !v)}
          className="text-left"
        >
          <div className="text-[11px] font-bold uppercase tracking-widest text-ink/50">
            Total {showBreakdown ? "▾" : "▴"}
          </div>
          <div className="flex items-baseline gap-2">
            <div className="text-2xl font-black text-ink">{inr(quote.total)}</div>
            {quote.discount && (
              <div className="text-base font-black text-ink/35 line-through">
                {inr(quote.gross)}
              </div>
            )}
          </div>
        </button>
        {/* Two ways to book, weighted the same: paying now or at the counter is
            the family's call, not something the layout should decide for them. */}
        <div className="mt-2 flex gap-2.5">
          {PAYMENTS_ENABLED && (
            <button
              type="button"
              onClick={() => pay(false)}
              // Same touchend treatment as the pay button — anything in this
              // fixed bar shifts mid-gesture when the keyboard closes.
              onTouchStart={() => {
                touchMoved.current = false;
              }}
              onTouchMove={() => {
                touchMoved.current = true;
              }}
              onTouchEnd={(e) => {
                if (touchMoved.current || busy) return;
                e.preventDefault();
                pay(false);
              }}
              disabled={busy}
              aria-disabled={!canSubmit}
              className={`flex-1 touch-manipulation rounded-full border-2 py-4 text-base font-black transition-all duration-150 active:translate-y-[2px] ${
                canSubmit
                  ? "border-ink/15 bg-white text-ink shadow-btn hover:bg-cream/60 active:shadow-btn-pressed"
                  : "border-ink/10 bg-white/50 text-ink/40"
              } ${busy ? "opacity-60" : ""}`}
            >
              {flow === "counter" && status === "booking" ? "Booking…" : "Pay at counter"}
            </button>
          )}
          <button
            type="button"
            onClick={() => pay()}
            // On mobile, tapping while the keyboard is open closes it and the
            // fixed bar shifts mid-gesture — the browser then drops the click.
            // touchend still targets the element the finger landed on, so it
            // books first-tap; preventDefault suppresses the follow-up click.
            onTouchStart={() => {
              touchMoved.current = false;
            }}
            onTouchMove={() => {
              touchMoved.current = true;
            }}
            onTouchEnd={(e) => {
              if (touchMoved.current || busy) return;
              e.preventDefault();
              pay();
            }}
            disabled={busy}
            aria-disabled={!canSubmit}
            className={`flex-1 touch-manipulation rounded-full border-2 border-transparent py-4 text-base font-black text-cream transition-all duration-150 active:translate-y-[2px] ${
              canSubmit
                ? "bg-coral shadow-btn hover:brightness-105 active:shadow-btn-pressed"
                : "bg-coral/40"
            } ${busy ? "opacity-60" : ""}`}
          >
            {flow === "online" && status === "booking" && "Booking…"}
            {status === "paying" && "Paying…"}
            {status === "verifying" && "Confirming…"}
            {(status === "idle" || (flow === "counter" && status === "booking")) &&
              (PAYMENTS_ENABLED ? `Pay ${inr(quote.total)}` : "Book now")}
          </button>
        </div>
      </div>

      {/* Busy overlay (hidden while the Razorpay modal owns the screen) */}
      {(status === "booking" || status === "verifying") && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-cream/95 backdrop-blur-sm">
          <Image
            src="/MascotWithoutBG.png"
            alt=""
            width={90}
            height={120}
            className="h-28 w-auto animate-bounce"
          />
          <div className="mt-4 text-lg font-black text-ink">
            {status === "booking" ? "Creating your booking…" : "Confirming your payment…"}
          </div>
          <div className="text-sm font-bold text-ink/50">Just a moment</div>
        </div>
      )}
    </main>
  );
}

function Stepper({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="flex items-center gap-1 rounded-full bg-cream p-1">
      <button
        type="button"
        aria-label="Decrease"
        onClick={() => onChange(Math.max(min, value - 1))}
        disabled={value <= min}
        className="grid h-9 w-9 place-items-center rounded-full bg-white text-lg font-black text-ink shadow-[0_3px_0_rgba(0,0,0,0.08)] transition-transform active:translate-y-[1px] disabled:opacity-40"
      >
        −
      </button>
      <span className="w-8 text-center text-base font-black tabular-nums text-ink">{value}</span>
      <button
        type="button"
        aria-label="Increase"
        onClick={() => onChange(Math.min(max, value + 1))}
        disabled={value >= max}
        className="grid h-9 w-9 place-items-center rounded-full bg-green text-lg font-black text-cream shadow-[0_3px_0_rgba(0,0,0,0.12)] transition-transform active:translate-y-[1px] disabled:opacity-40"
      >
        +
      </button>
    </div>
  );
}
