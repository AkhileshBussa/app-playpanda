"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { computeQuote, EXTRA_ADULT, PACKAGES, SOCKS, type PackageId } from "@/lib/pricing";

const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;

// While Razorpay isn't live yet, this is "false": bookings create the invoice
// but skip online payment (pay at the counter).
const PAYMENTS_ENABLED = process.env.NEXT_PUBLIC_PAYMENTS_ENABLED !== "false";

interface CheckoutResponse {
  invoiceNumber: string;
  /** Opaque billing-backend handle (used later to record payment). */
  ref: string;
  total: number;
  skipPayment?: boolean;
}

type Status = "idle" | "booking";

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
  const [error, setError] = useState<string | null>(null);
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [welcomeBack, setWelcomeBack] = useState<string | null>(null);

  const canSubmit = name.trim().length >= 2 && /^[6-9]\d{9}$/.test(phone);

  // Returning customers: on a valid phone, prefill name + kids' names from
  // Swipe (their Child N custom fields). Debounced, silent on failure, and
  // never overwrites anything the customer has already typed.
  useEffect(() => {
    if (!/^[6-9]\d{9}$/.test(phone)) {
      setWelcomeBack(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/customer/lookup?phone=${phone}`);
        const data = await res.json();
        if (cancelled || !data.found) return;
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

  // Re-submitting the same selection reuses the created invoice instead of
  // creating a duplicate in Swipe.
  const checkoutCache = useRef<{ key: string; data: CheckoutResponse } | null>(null);

  const quote = useMemo(
    () => computeQuote({ packageId, kids, extraAdults, childSocks, adultSocks }),
    [packageId, kids, extraAdults, childSocks, adultSocks]
  );

  const pay = async () => {
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
    setError(null);
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
      };
      const cacheKey = JSON.stringify(payload);

      let checkout = checkoutCache.current?.key === cacheKey ? checkoutCache.current.data : null;
      if (!checkout) {
        const res = await fetch("/api/checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Something went wrong");
        checkout = data as CheckoutResponse;
        checkoutCache.current = { key: cacheKey, data: checkout };
      }

      // Invoice created in Swipe. The confirmation screen is keyed by the
      // invoice number (without prefix) and fetches everything from the backend.
      const number = checkout.invoiceNumber.replace(/^\D+/, "");
      router.push(`/success/${encodeURIComponent(number)}`);
    } catch (err) {
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
            width={96}
            height={96}
            priority
            className="h-20 w-20 -translate-x-2"
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

        {/* Package */}
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
            <div className="text-base font-black text-ink">Grip socks</div>
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
            {quote.lines.map((line) => (
              <div key={line.sku} className="flex justify-between text-sm font-bold text-ink/70">
                <span>
                  {line.displayName} × {line.quantity}
                </span>
                <span>{inr(line.lineTotal)}</span>
              </div>
            ))}
            <div className="pt-1 text-[11px] font-bold text-ink/40">Prices include GST</div>
          </div>
        )}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setShowBreakdown((v) => !v)}
            className="text-left"
          >
            <div className="text-[11px] font-bold uppercase tracking-widest text-ink/50">
              Total {showBreakdown ? "▾" : "▴"}
            </div>
            <div className="text-2xl font-black text-ink">{inr(quote.total)}</div>
          </button>
          <button
            type="button"
            onClick={pay}
            disabled={busy}
            aria-disabled={!canSubmit}
            className={`ml-auto inline-flex items-center justify-center rounded-full px-8 py-4 text-base font-black text-cream transition-all duration-150 active:translate-y-[2px] ${
              canSubmit
                ? "bg-coral shadow-btn hover:brightness-105 active:shadow-btn-pressed"
                : "bg-coral/40"
            } ${busy ? "opacity-60" : ""}`}
          >
            {status === "booking" && "Booking…"}
            {status === "idle" && (PAYMENTS_ENABLED ? `Pay ${inr(quote.total)}` : "Book now")}
          </button>
        </div>
      </div>

      {/* Booking overlay */}
      {status === "booking" && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-cream/95 backdrop-blur-sm">
          <Image
            src="/MascotWithoutBG.png"
            alt=""
            width={90}
            height={120}
            className="h-28 w-auto animate-bounce"
          />
          <div className="mt-4 text-lg font-black text-ink">Creating your booking…</div>
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
