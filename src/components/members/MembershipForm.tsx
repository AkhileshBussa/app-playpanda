"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { normalizePhone, type Membership } from "@/lib/members/types";
import DuplicateMembershipSheet from "./DuplicateMembershipSheet";
import { addMonths, MEMBERSHIP_PLANS, PUNCH_PRODUCTS } from "@/lib/members/plans";
import { PAYMENT_METHODS, type PaymentMethod } from "@/lib/billing/types";

/** Today's membership sale invoices, as the pick-list API returns them. */
interface SaleInvoiceOption {
  invoiceNumber: string;
  customerName: string;
  phone: string;
  amount: number;
  at: number;
  planLines: Array<{ sku: string; name: string; quantity: number }>;
  /** How Swipe says it was paid; "" when nothing is collected or it's split. */
  paidBy: "" | PaymentMethod;
  amountPaid: number;
  /** Already referenced by another membership — a flag, not a block. */
  linked: boolean;
}

interface MembershipFormProps {
  /** Optional starting phone, e.g. arriving from the counter's lookup. */
  initialPhone?: string;
}

const inputClass =
  "w-full rounded-2xl border-2 border-ink/10 bg-cream/60 px-4 py-3 text-base font-bold text-ink outline-none placeholder:font-bold placeholder:text-ink/30 focus:border-coral";

const labelClass = "mb-1 block px-1 text-sm font-bold uppercase tracking-widest text-ink/50";

const todayIST = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

const timeIST = (ms: number) =>
  new Date(ms).toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });

/**
 * Sell a membership. Standalone — the manager does NOT have to look anyone up
 * first. Saving bills the sale in Swipe and takes the payment, then records the
 * membership so visits can be punched against it. A sale billed in Swipe
 * already can still be linked instead. Custom plans set their own plays/hours
 * but bill and punch on an existing Swipe product.
 */
export default function MembershipForm({ initialPhone = "" }: MembershipFormProps) {
  const router = useRouter();
  const [phone, setPhone] = useState(initialPhone);
  const [customerName, setCustomerName] = useState("");
  const [kidNames, setKidNames] = useState("");
  const [planKey, setPlanKey] = useState<string>(MEMBERSHIP_PLANS[0].key);
  const [saleMode, setSaleMode] = useState<"bill" | "link">("bill");
  const [price, setPrice] = useState(String(MEMBERSHIP_PLANS[0].priceWithTax));
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(PAYMENT_METHODS[0]);
  const [transactionRef, setTransactionRef] = useState("");
  const [saleInvoice, setSaleInvoice] = useState("");
  // One date: a membership starts the day it's recorded, so this drives both.
  const [createdOn, setCreatedOn] = useState(todayIST());
  const [notes, setNotes] = useState("");
  // Custom plan fields
  const [customName, setCustomName] = useState("");
  const [customPunchId, setCustomPunchId] = useState(PUNCH_PRODUCTS[0].id);
  const [customUnlimited, setCustomUnlimited] = useState(false);
  const [customPlays, setCustomPlays] = useState("10");
  const [customHours, setCustomHours] = useState("2");
  const [customKidsPerPlay, setCustomKidsPerPlay] = useState("1");
  const [customValidity, setCustomValidity] = useState("6");
  const [customWeekdaysOnly, setCustomWeekdaysOnly] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Today's membership sales from Swipe; null while loading.
  const [saleOptions, setSaleOptions] = useState<SaleInvoiceOption[] | null>(null);
  const [salesError, setSalesError] = useState<string | null>(null);
  /** Typing the number instead of picking (sale billed earlier, or Swipe down). */
  const [manualInvoice, setManualInvoice] = useState(false);
  const [duplicate, setDuplicate] = useState<{
    existing: Membership;
    activeCount: number;
    samePlan: boolean;
  } | null>(null);

  // Once a full number is typed, pull the customer's name and kids from Swipe
  // so the manager doesn't retype what billing already knows. Fills blanks only
  // — anything already typed wins.
  useEffect(() => {
    const p = normalizePhone(phone);
    if (p.length !== 10) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/members/lookup?phone=${p}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { customer?: { name: string; kidNames: string[] } | null };
        if (cancelled || !data.customer) return;
        setCustomerName((cur) => cur.trim() || data.customer!.name || "");
        setKidNames((cur) => cur.trim() || (data.customer!.kidNames ?? []).join(", "));
      } catch {
        // Prefill is a convenience; typing by hand still works.
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [phone]);

  // Only the "already billed in Swipe" path needs the pick-list, so it's
  // fetched when that path is chosen rather than on every form open.
  useEffect(() => {
    if (saleMode !== "link" || saleOptions !== null) return;
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch("/api/members/sale-invoices", { cache: "no-store" });
        if (res.status === 401) {
          window.location.reload();
          return;
        }
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok || !Array.isArray(data.invoices)) {
          throw new Error(data.error || "Couldn't load today's invoices");
        }
        setSaleOptions(data.invoices as SaleInvoiceOption[]);
      } catch (err) {
        if (cancelled) return;
        // Swipe unreachable — fall back to typing so the form still works.
        setSaleOptions([]);
        setSalesError(err instanceof Error ? err.message : "Couldn't load today's invoices");
        setManualInvoice(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [saleMode, saleOptions]);

  // Typing a number that turns out to be one of today's sales populates from
  // it too — the pick-list and the keyboard shouldn't behave differently.
  const appliedInvoice = useRef("");
  useEffect(() => {
    const number = saleInvoice.trim();
    if (!manualInvoice || !number || appliedInvoice.current === number) return;
    const match = (saleOptions ?? []).find((s) => s.invoiceNumber === number);
    if (!match) return;
    appliedInvoice.current = number;
    applySale(match);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saleInvoice, manualInvoice, saleOptions]);

  const isCustom = planKey === "custom";
  const fixedPlan = MEMBERSHIP_PLANS.find((p) => p.key === planKey);
  const validityMonths = isCustom ? parseInt(customValidity) || 0 : fixedPlan?.validityMonths ?? 0;
  const expiresOn =
    /^\d{4}-\d{2}-\d{2}$/.test(createdOn) && validityMonths > 0
      ? addMonths(createdOn, validityMonths)
      : null;

  // Fixed plans show only the sales carrying that plan's product; a custom
  // plan has no product of its own, so every membership sale is a candidate.
  const matchingSales = !saleOptions
    ? []
    : isCustom
      ? saleOptions
      : saleOptions.filter((s) =>
          s.planLines.some((l) => l.sku === String(fixedPlan?.saleProductId ?? ""))
        );

  const selectedSale = matchingSales.find((s) => s.invoiceNumber === saleInvoice);
  const salePhone = selectedSale ? normalizePhone(selectedSale.phone) : "";
  // A different billing number usually means the wrong invoice was tapped.
  const phoneMismatch =
    salePhone.length === 10 && normalizePhone(phone).length === 10 && salePhone !== normalizePhone(phone);

  /** Switching plan re-prices the sale and can invalidate a picked invoice. */
  const selectPlan = (key: string) => {
    setPlanKey(key);
    const plan = MEMBERSHIP_PLANS.find((p) => p.key === key);
    setPrice(plan ? String(plan.priceWithTax) : "");
    if (!manualInvoice) setSaleInvoice("");
  };

  /**
   * Take from the invoice everything it already knows, so the counter isn't
   * retyping what Swipe has: the customer, the phone, the plan the sale was
   * billed on, what it charged and how it was paid. Typed-in values win —
   * only blanks are filled — except the money and the method, which the
   * invoice is the authority on.
   */
  const applySale = (sale: SaleInvoiceOption) => {
    if (!customerName.trim() && sale.customerName) setCustomerName(sale.customerName);
    const salePhoneDigits = normalizePhone(sale.phone);
    if (normalizePhone(phone).length !== 10 && salePhoneDigits.length === 10) {
      setPhone(salePhoneDigits);
    }
    const billedPlan = MEMBERSHIP_PLANS.find((p) =>
      sale.planLines.some((l) => l.sku === String(p.saleProductId))
    );
    if (billedPlan && billedPlan.key !== planKey) setPlanKey(billedPlan.key);
    if (sale.amount > 0) setPrice(String(sale.amount));
    if (sale.paidBy) {
      setPaymentMethod(sale.paidBy);
      if (sale.paidBy !== "Card") setTransactionRef("");
    }
  };

  const pickSale = (sale: SaleInvoiceOption) => {
    const next = saleInvoice === sale.invoiceNumber ? "" : sale.invoiceNumber;
    setSaleInvoice(next);
    if (next) applySale(sale);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void save(false);
  };

  const save = async (force: boolean) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const priceInr = price.trim() === "" ? null : parseFloat(price);
      const body: Record<string, unknown> = {
        phone,
        customerName: customerName.trim(),
        kidNames: kidNames.trim(),
        planKey,
        saleMode,
        priceInr,
        paymentMethod,
        transactionRef: transactionRef.trim(),
        saleInvoiceNumber: saleMode === "link" ? saleInvoice.trim() : "",
        createdOn,
        notes: notes.trim(),
        force,
      };
      if (isCustom) {
        body.custom = {
          name: customName.trim(),
          punchProductId: customPunchId,
          totalPlays: customUnlimited ? null : parseInt(customPlays) || 0,
          hoursPerPlay: parseFloat(customHours) || 0,
          kidsPerPlay: parseInt(customKidsPerPlay) || 1,
          validityMonths: parseInt(customValidity) || 0,
          priceInr,
          weekdaysOnly: customWeekdaysOnly,
          oncePerDay: customUnlimited, // unlimited passes are once-per-day by definition
        };
      }

      const res = await fetch("/api/members/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        window.location.reload();
        return;
      }
      if (res.status === 409 && data.duplicate) {
        setDuplicate({
          existing: data.existing as Membership,
          activeCount: (data.activeCount as number) ?? 1,
          samePlan: Boolean(data.samePlan),
        });
        setSaving(false);
        return;
      }
      setDuplicate(null);
      if (!res.ok || !data.membership) {
        throw new Error(data.error || "Couldn't save — please try again");
      }
      // Hand the manager straight to the counter for this member, where the
      // new membership is listed and ready to punch. The invoice number rides
      // along so the counter sees what was billed without opening Swipe.
      const params = new URLSearchParams({ phone: normalizePhone(phone), created: "1" });
      if (data.saleInvoiceNumber) params.set("invoice", data.saleInvoiceNumber);
      if (data.warning) params.set("warning", data.warning);
      router.push(`/members?${params.toString()}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save — please try again");
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-xl">
      <form onSubmit={submit} className="space-y-4 rounded-chunk bg-white p-5 shadow-chunk">
          <div>
            <label className={labelClass}>Phone number *</label>
            <input
              type="tel"
              inputMode="numeric"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="10-digit mobile"
              className={inputClass}
              required
            />
          </div>

          <div>
            <label className={labelClass}>Customer name *</label>
            <input
              type="text"
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              placeholder="Parent's name"
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
            <label className={labelClass}>Plan *</label>
            <div className="flex flex-col gap-2">
              {MEMBERSHIP_PLANS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => selectPlan(p.key)}
                  className={`flex items-center justify-between rounded-2xl border-2 px-4 py-3 text-left transition-colors ${
                    planKey === p.key
                      ? "border-teal bg-teal/10"
                      : "border-ink/10 bg-white hover:border-ink/20"
                  }`}
                >
                  <span>
                    <span className="block text-base font-black text-ink">{p.name}</span>
                    <span className="block text-xs font-bold text-ink/50">{p.blurb}</span>
                  </span>
                  <span className="shrink-0 text-base font-black text-ink/70">
                    ₹{p.priceWithTax.toLocaleString("en-IN")}
                  </span>
                </button>
              ))}
              <button
                type="button"
                onClick={() => selectPlan("custom")}
                className={`rounded-2xl border-2 px-4 py-3 text-left transition-colors ${
                  isCustom ? "border-teal bg-teal/10" : "border-dashed border-ink/20 bg-white hover:border-ink/30"
                }`}
              >
                <span className="block text-base font-black text-ink">Custom plan</span>
                <span className="block text-xs font-bold text-ink/50">
                  Your own plays & hours, punched on an existing Swipe product
                </span>
              </button>
            </div>
          </div>

          {isCustom && (
            <div className="space-y-4 rounded-2xl border-2 border-teal/30 bg-white p-4">
              <div>
                <label className={labelClass}>Custom plan name *</label>
                <input
                  type="text"
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  placeholder="e.g. Birthday Special 8"
                  className={inputClass}
                  required={isCustom}
                />
              </div>

              <div>
                <label className={labelClass}>Punches as (Swipe product) *</label>
                <select
                  value={customPunchId}
                  onChange={(e) => setCustomPunchId(Number(e.target.value))}
                  className={inputClass}
                >
                  {PUNCH_PRODUCTS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <p className="mt-1 px-1 text-xs font-bold text-ink/40">
                  The sale bills on this product&apos;s plan, and each visit creates a ₹0 invoice
                  with it — so Swipe stays in sync.
                </p>
              </div>

              <div>
                <label className={labelClass}>Plays</label>
                <div className="flex gap-2">
                  {[
                    { unlimited: false, label: "Fixed plays" },
                    { unlimited: true, label: "Unlimited · 1/day" },
                  ].map((opt) => (
                    <button
                      key={opt.label}
                      type="button"
                      onClick={() => setCustomUnlimited(opt.unlimited)}
                      className={`flex h-11 flex-1 items-center justify-center whitespace-nowrap rounded-full text-sm font-black leading-none transition-colors ${
                        customUnlimited === opt.unlimited
                          ? "bg-ink text-cream"
                          : "bg-cream text-ink/60 hover:bg-ink/10"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                {!customUnlimited && (
                  <div>
                    <label className={labelClass}>Total plays *</label>
                    <input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      value={customPlays}
                      onChange={(e) => setCustomPlays(e.target.value)}
                      className={inputClass}
                      required={isCustom && !customUnlimited}
                    />
                  </div>
                )}
                <div>
                  <label className={labelClass}>Hours per play *</label>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0.5}
                    step={0.5}
                    value={customHours}
                    onChange={(e) => setCustomHours(e.target.value)}
                    className={inputClass}
                    required={isCustom}
                  />
                </div>
                <div>
                  <label className={labelClass}>Kids per play</label>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={10}
                    value={customKidsPerPlay}
                    onChange={(e) => setCustomKidsPerPlay(e.target.value)}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>Validity (months) *</label>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={36}
                    value={customValidity}
                    onChange={(e) => setCustomValidity(e.target.value)}
                    className={inputClass}
                    required={isCustom}
                  />
                </div>
              </div>

              <label className="flex items-center gap-2 px-1 text-sm font-bold text-ink/70">
                <input
                  type="checkbox"
                  checked={customWeekdaysOnly}
                  onChange={(e) => setCustomWeekdaysOnly(e.target.checked)}
                  className="h-5 w-5 accent-teal"
                />
                Valid Monday–Friday only
              </label>
            </div>
          )}

          <div>
            <label className={labelClass}>The sale</label>
            <div className="flex gap-2">
              {([
                { mode: "bill", label: "Bill it now" },
                { mode: "link", label: "Already billed" },
              ] as const).map((opt) => (
                <button
                  key={opt.mode}
                  type="button"
                  onClick={() => setSaleMode(opt.mode)}
                  className={`flex h-11 flex-1 items-center justify-center whitespace-nowrap rounded-full text-sm font-black leading-none transition-colors ${
                    saleMode === opt.mode
                      ? "bg-ink text-cream"
                      : "bg-cream text-ink/60 hover:bg-ink/10"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {saleMode === "bill" ? (
              <div className="mt-3 space-y-3">
                <div>
                  <label className={labelClass}>Amount charged (₹) *</label>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                    className={inputClass}
                    required={saleMode === "bill"}
                  />
                  <p className="mt-1 px-1 text-xs font-bold text-ink/40">
                    Saving raises this invoice in Swipe on the plan&apos;s product — no need to
                    bill it there first.
                  </p>
                </div>

              </div>
            ) : manualInvoice ? (
              <>
                <input
                  type="text"
                  value={saleInvoice}
                  onChange={(e) => setSaleInvoice(e.target.value)}
                  placeholder="e.g. INV-1665 (optional)"
                  className={inputClass}
                />
                <p className="mt-1 px-1 text-xs font-bold text-ink/40">
                  Optional — leave it blank for a sale with no invoice to point at.
                </p>
                {matchingSales.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setManualInvoice(false);
                      setSaleInvoice("");
                    }}
                    className="mt-2 px-1 text-xs font-black text-teal underline underline-offset-2"
                  >
                    Pick from today&apos;s invoices instead
                  </button>
                )}
              </>
            ) : saleOptions === null ? (
              <p className="px-1 text-sm font-bold text-ink/40">Loading today&apos;s Swipe invoices…</p>
            ) : (
              <>
                {matchingSales.length === 0 ? (
                  <p className="rounded-2xl bg-cream px-3 py-2.5 text-sm font-bold text-ink/50">
                    No membership sale billed today
                    {isCustom ? "" : ` for ${fixedPlan?.name}`} — switch to &ldquo;Bill it
                    now&rdquo;, or enter the number manually.
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {matchingSales.map((s) => (
                      <button
                        key={s.invoiceNumber}
                        type="button"
                        onClick={() => pickSale(s)}
                        className={`rounded-2xl border-2 px-4 py-3 text-left transition-colors ${
                          saleInvoice === s.invoiceNumber
                            ? "border-teal bg-teal/10"
                            : "border-ink/10 bg-white hover:border-ink/20"
                        }`}
                      >
                        <span className="flex items-baseline justify-between gap-2">
                          <span className="text-base font-black text-ink">{s.invoiceNumber}</span>
                          <span className="shrink-0 text-sm font-black text-ink/70">
                            ₹{s.amount.toLocaleString("en-IN")}
                          </span>
                        </span>
                        <span className="block truncate text-xs font-bold text-ink/50">
                          {s.customerName || "No name"}
                          {s.phone && ` · ${s.phone}`} · {timeIST(s.at)}
                        </span>
                        <span className="mt-1.5 flex flex-wrap gap-1">
                          {s.planLines.map((l, i) => (
                            <span
                              key={`${l.sku}-${i}`}
                              className="rounded-full bg-cream px-2 py-0.5 text-[11px] font-black text-ink/60"
                            >
                              {l.name}
                            </span>
                          ))}
                          {s.linked && (
                            <span className="rounded-full bg-yellow/25 px-2 py-0.5 text-[11px] font-black text-brown">
                              already linked
                            </span>
                          )}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setManualInvoice(true)}
                  className="mt-2 px-1 text-xs font-black text-ink/50 underline underline-offset-2"
                >
                  Not listed? Enter it manually
                </button>
              </>
            )}
            {saleMode === "link" && salesError && (
              <p className="mt-1 px-1 text-xs font-bold text-coral">
                {salesError} — enter the number manually.
              </p>
            )}
            {saleMode === "link" && phoneMismatch && selectedSale && (
              <p className="mt-2 rounded-2xl bg-yellow/25 px-3 py-2 text-sm font-bold text-ink/80">
                Heads up: {selectedSale.invoiceNumber} is billed to {selectedSale.phone}, not{" "}
                {normalizePhone(phone)}. Check it&apos;s the right sale.
              </p>
            )}

            {saleMode === "link" && (
              <div className="mt-3">
                <label className={labelClass}>Amount on this membership (₹)</label>
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  className={inputClass}
                />
                <p className="mt-1 px-1 text-xs font-bold text-ink/40">
                  {selectedSale
                    ? `From ${selectedSale.invoiceNumber} — its total, including anything else on that bill. Trim it to what the plan cost.`
                    : "Nothing is collected here; this is only what the membership records."}
                </p>
              </div>
            )}

            <div className="mt-3">
              <label className={labelClass}>Paid by *</label>
              <div className="flex gap-2">
                {PAYMENT_METHODS.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => {
                      setPaymentMethod(m);
                      if (m !== "Card") setTransactionRef("");
                    }}
                    className={`flex h-11 flex-1 items-center justify-center whitespace-nowrap rounded-full px-2 text-sm font-black leading-none transition-colors ${
                      paymentMethod === m
                        ? "bg-teal text-cream"
                        : "bg-cream text-ink/60 hover:bg-ink/10"
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
              {paymentMethod === "Card" && (
                <input
                  type="text"
                  value={transactionRef}
                  onChange={(e) => setTransactionRef(e.target.value)}
                  placeholder="Card ref (optional)"
                  className={`${inputClass} mt-2`}
                />
              )}
              <p className="mt-1 px-1 text-xs font-bold text-ink/40">
                {saleMode === "bill"
                  ? "Collected against the invoice this raises."
                  : selectedSale?.paidBy
                    ? `From ${selectedSale.invoiceNumber} — Swipe says ${selectedSale.paidBy}. Change it if that's wrong.`
                    : "Recorded on the membership — nothing is collected here."}
              </p>
            </div>
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
              The day this membership is recorded under, and the day it starts —
              back-date it for a sale taken earlier. The Swipe invoice is always
              dated today.
            </p>
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

          {expiresOn && (
            <p className="rounded-2xl bg-teal/10 px-3 py-2 text-sm font-bold text-ink/70">
              Will expire on{" "}
              <span className="font-black text-ink">
                {new Date(`${expiresOn}T12:00:00+05:30`).toLocaleDateString("en-IN", {
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                  timeZone: "Asia/Kolkata",
                })}
              </span>
              {" "}({validityMonths} month{validityMonths === 1 ? "" : "s"})
            </p>
          )}

          {error && <p className="px-1 text-sm font-bold text-coral">{error}</p>}

          <button
            type="submit"
            disabled={saving}
            className="w-full rounded-full bg-coral py-3.5 text-base font-black text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save membership"}
          </button>
      </form>

      {duplicate && (
        <DuplicateMembershipSheet
          existing={duplicate.existing}
          activeCount={duplicate.activeCount}
          samePlan={duplicate.samePlan}
          planName={isCustom ? customName.trim() || "custom plan" : fixedPlan?.name ?? "membership"}
          busy={saving}
          onCancel={() => setDuplicate(null)}
          onConfirm={() => void save(true)}
        />
      )}
    </div>
  );
}
