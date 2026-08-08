"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { normalizePhone } from "@/lib/members/types";
import { addMonths, MEMBERSHIP_PLANS, PUNCH_PRODUCTS } from "@/lib/members/plans";

/** Today's membership sale invoices, as the pick-list API returns them. */
interface SaleInvoiceOption {
  invoiceNumber: string;
  customerName: string;
  phone: string;
  amount: number;
  at: number;
  planLines: Array<{ sku: string; name: string; quantity: number }>;
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
 * Record a membership the customer just bought. Standalone — the manager does
 * NOT have to look anyone up first. The sale invoice is billed manually in
 * Swipe exactly as before; this form only records the membership so visits can
 * be tracked and punched. Custom plans set their own plays/hours but must map
 * to one of the existing Swipe punch products.
 */
export default function MembershipForm({ initialPhone = "" }: MembershipFormProps) {
  const router = useRouter();
  const [phone, setPhone] = useState(initialPhone);
  const [customerName, setCustomerName] = useState("");
  const [kidNames, setKidNames] = useState("");
  const [planKey, setPlanKey] = useState<string>(MEMBERSHIP_PLANS[0].key);
  const [saleInvoice, setSaleInvoice] = useState("");
  const [startsOn, setStartsOn] = useState(todayIST());
  const [notes, setNotes] = useState("");
  // Custom plan fields
  const [customName, setCustomName] = useState("");
  const [customPunchId, setCustomPunchId] = useState(PUNCH_PRODUCTS[0].id);
  const [customUnlimited, setCustomUnlimited] = useState(false);
  const [customPlays, setCustomPlays] = useState("10");
  const [customHours, setCustomHours] = useState("2");
  const [customKidsPerPlay, setCustomKidsPerPlay] = useState("1");
  const [customValidity, setCustomValidity] = useState("6");
  const [customPrice, setCustomPrice] = useState("");
  const [customWeekdaysOnly, setCustomWeekdaysOnly] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Today's membership sales from Swipe; null while loading.
  const [saleOptions, setSaleOptions] = useState<SaleInvoiceOption[] | null>(null);
  const [salesError, setSalesError] = useState<string | null>(null);
  /** Typing the number instead of picking (sale billed earlier, or Swipe down). */
  const [manualInvoice, setManualInvoice] = useState(false);
  // Armed after the duplicate warning; the next submit forces.
  const forceArmed = useRef(false);

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

  // Load today's membership sales so the manager picks the invoice they just
  // billed rather than typing its number.
  useEffect(() => {
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
  }, []);

  const isCustom = planKey === "custom";
  const fixedPlan = MEMBERSHIP_PLANS.find((p) => p.key === planKey);
  const validityMonths = isCustom ? parseInt(customValidity) || 0 : fixedPlan?.validityMonths ?? 0;
  const expiresOn =
    /^\d{4}-\d{2}-\d{2}$/.test(startsOn) && validityMonths > 0
      ? addMonths(startsOn, validityMonths)
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

  /** Switching plan can invalidate the picked invoice, so drop the selection. */
  const selectPlan = (key: string) => {
    setPlanKey(key);
    if (!manualInvoice) setSaleInvoice("");
  };

  const pickSale = (sale: SaleInvoiceOption) => {
    const next = saleInvoice === sale.invoiceNumber ? "" : sale.invoiceNumber;
    setSaleInvoice(next);
    // Fill the name from the invoice only when it's still blank.
    if (next && !customerName.trim() && sale.customerName) setCustomerName(sale.customerName);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        phone,
        customerName: customerName.trim(),
        kidNames: kidNames.trim(),
        planKey,
        saleInvoiceNumber: saleInvoice.trim(),
        startsOn,
        notes: notes.trim(),
        force: forceArmed.current,
      };
      if (isCustom) {
        body.custom = {
          name: customName.trim(),
          punchProductId: customPunchId,
          totalPlays: customUnlimited ? null : parseInt(customPlays) || 0,
          hoursPerPlay: parseFloat(customHours) || 0,
          kidsPerPlay: parseInt(customKidsPerPlay) || 1,
          validityMonths: parseInt(customValidity) || 0,
          priceInr: customPrice.trim() === "" ? null : parseFloat(customPrice),
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
        forceArmed.current = true;
        setNotice(
          "This number already has an active membership on the same plan — tap Save again to add another anyway."
        );
        return;
      }
      if (!res.ok || !data.membership) {
        throw new Error(data.error || "Couldn't save — please try again");
      }
      // Hand the manager straight to the counter for this member, where the
      // new membership is listed and ready to punch.
      router.push(`/members?phone=${normalizePhone(phone)}&created=1`);
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
                  Each visit creates a ₹0 invoice with this product, so Swipe stays in sync.
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
                <div>
                  <label className={labelClass}>Price (₹)</label>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    value={customPrice}
                    onChange={(e) => setCustomPrice(e.target.value)}
                    placeholder="Optional"
                    className={inputClass}
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
            <label className={labelClass}>Sale invoice</label>
            {manualInvoice ? (
              <>
                <input
                  type="text"
                  value={saleInvoice}
                  onChange={(e) => setSaleInvoice(e.target.value)}
                  placeholder="e.g. INV-1665"
                  className={inputClass}
                />
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
                    {isCustom ? "" : ` for ${fixedPlan?.name}`} — bill it in Swipe first, or enter
                    the number manually.
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
            {salesError && (
              <p className="mt-1 px-1 text-xs font-bold text-coral">
                {salesError} — enter the number manually.
              </p>
            )}
            {phoneMismatch && selectedSale && (
              <p className="mt-2 rounded-2xl bg-yellow/25 px-3 py-2 text-sm font-bold text-ink/80">
                Heads up: {selectedSale.invoiceNumber} is billed to {selectedSale.phone}, not{" "}
                {normalizePhone(phone)}. Check it&apos;s the right sale.
              </p>
            )}
          </div>

          <div>
            <label className={labelClass}>Starts on</label>
            <input
              type="date"
              value={startsOn}
              onChange={(e) => setStartsOn(e.target.value)}
              className={inputClass}
            />
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

          {notice && (
            <p className="rounded-2xl bg-yellow/25 px-3 py-2 text-sm font-bold text-ink/80">{notice}</p>
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
    </div>
  );
}
