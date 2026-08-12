"use client";

import { useCallback, useEffect, useState } from "react";
import { formatInr } from "@/lib/pricing";
import { CUSTOMER_CODES_ENABLED } from "@/lib/discounts/enabled";
import type { DiscountCode, DiscountRedemption, DiscountUsage } from "@/lib/discounts/types";

interface BoardData {
  codes: DiscountCode[];
  redemptions: DiscountRedemption[];
}

// Exact, not rounded: this is the ledger of what was given away, and "₹209"
// where ₹209.70 came off is the kind of small lie that costs an hour later.
const rupees = formatInr;

const day = (ms: number) =>
  new Date(ms).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    timeZone: "Asia/Kolkata",
  });

const dayTime = (ms: number) =>
  new Date(ms).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });

/** "20% off, up to ₹200" / "₹100 off" — the terms in one line. */
function terms(code: DiscountCode): string {
  const head = code.kind === "percent" ? `${code.value}% off` : `${rupees(code.value)} off`;
  const cap = code.kind === "percent" && code.maxDiscount ? `, up to ${rupees(code.maxDiscount)}` : "";
  const min = code.minOrder > 0 ? ` · min ${rupees(code.minOrder)}` : "";
  return `${head}${cap}${min}`;
}

/** How many uses are left, in the counter's words rather than the schema's. */
function usageLabel(code: DiscountCode): string {
  if (code.usage === "single") {
    return code.timesUsed >= 1 ? "Single use · used" : "Single use";
  }
  if (code.usage === "per_customer") {
    return `${code.perCustomerLimit ?? 1}× per customer`;
  }
  return "Unlimited";
}

/**
 * Whether a code would be refused right now for a reason that isn't its own
 * active flag — spent out, or outside its dates. Worth showing next to an
 * otherwise-"active" code, because that's the state staff get asked about.
 */
function dormantReason(code: DiscountCode, now: number): string | null {
  if (code.totalLimit != null && code.timesUsed >= code.totalLimit) return "used up";
  if (code.startsAt != null && now < code.startsAt) return `from ${day(code.startsAt)}`;
  if (code.expiresAt != null && now > code.expiresAt) return "expired";
  return null;
}

const USAGE_OPTIONS: { value: DiscountUsage; label: string; hint: string }[] = [
  { value: "multi", label: "Unlimited", hint: "Anyone, any number of times" },
  { value: "per_customer", label: "Per customer", hint: "Capped per mobile number" },
  { value: "single", label: "Single use", hint: "One redemption in total" },
];

export default function DiscountBoard() {
  const [data, setData] = useState<BoardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"codes" | "redemptions">("codes");
  const [showForm, setShowForm] = useState(false);
  const [staff, setStaff] = useState<{ id: string; name: string }[]>([]);
  const now = Date.now();

  useEffect(() => {
    fetch("/api/ops/employees")
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        setStaff(
          (body?.employees ?? [])
            .filter((e: { active: boolean }) => e.active)
            .map((e: { id: string; name: string }) => ({ id: e.id, name: e.name }))
        );
      })
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/ops/discounts");
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Couldn't load discounts");
      setData(body);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load discounts");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = async (code: DiscountCode) => {
    // Optimistic: the switch is the whole interaction, and waiting on a round
    // trip to move it makes the page feel broken.
    setData((prev) =>
      prev
        ? {
            ...prev,
            codes: prev.codes.map((c) => (c.id === code.id ? { ...c, active: !c.active } : c)),
          }
        : prev
    );
    try {
      const res = await fetch("/api/ops/discounts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: code.id, active: !code.active }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setError(`Couldn't ${code.active ? "pause" : "resume"} ${code.code}`);
      load();
    }
  };

  const given = (data?.redemptions ?? []).filter((r) => r.status !== "released");
  const totalGiven = given.reduce((sum, r) => sum + r.discount, 0);

  return (
    <div className="mx-auto w-full max-w-3xl px-3 pb-24">
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1.5">
          {(
            [
              ["codes", "Codes"],
              ["redemptions", "Given"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`h-10 rounded-full px-4 text-sm font-black transition-colors ${
                tab === key ? "bg-ink text-cream" : "bg-white text-ink/60 hover:bg-ink/10"
              }`}
            >
              {label}
              {key === "redemptions" && given.length > 0 && ` · ${given.length}`}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className="h-10 rounded-full bg-coral px-4 text-sm font-black text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed"
        >
          {showForm ? "Cancel" : "+ New code"}
        </button>
      </div>

      {error && (
        <div className="mt-3 rounded-2xl bg-coral/10 px-3 py-2 text-sm font-bold text-coral">
          {error}
        </div>
      )}

      {showForm && (
        <NewCodeForm
          staff={staff}
          onCreated={() => {
            setShowForm(false);
            setTab("codes");
            load();
          }}
        />
      )}

      {loading && !data ? (
        <p className="mt-6 px-1 text-sm font-bold text-ink/40">Loading…</p>
      ) : tab === "codes" ? (
        <div className="mt-3 space-y-2">
          {(data?.codes ?? []).length === 0 ? (
            <p className="mt-6 px-1 text-sm font-bold text-ink/40">
              No codes yet. Make one and it can be used{" "}
              {CUSTOMER_CODES_ENABLED ? "at self-checkout or at the counter" : "at the counter"}.
            </p>
          ) : (
            data?.codes.map((code) => {
              const dormant = dormantReason(code, now);
              return (
                <div
                  key={code.id}
                  className={`rounded-chunk bg-white p-4 shadow-chunk ${
                    code.active ? "" : "opacity-60"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="text-lg font-black tracking-wider text-ink">
                          {code.code}
                        </span>
                        <span className="text-sm font-black text-green">{terms(code)}</span>
                        {dormant && code.active && (
                          <span className="rounded-full bg-yellow/40 px-2 py-0.5 text-[11px] font-black uppercase tracking-wide text-ink/70">
                            {dormant}
                          </span>
                        )}
                      </div>
                      <div className="mt-1 text-xs font-bold text-ink/50">
                        {usageLabel(code)} · {code.channels.join(" + ")} · used {code.timesUsed}×
                      </div>
                      <div className="mt-0.5 text-xs font-bold text-ink/35">
                        {code.createdByName ? `${code.createdByName}, ` : ""}
                        {day(code.createdAt)}
                        {code.expiresAt != null && ` · ends ${day(code.expiresAt)}`}
                        {code.note && ` · ${code.note}`}
                      </div>
                    </div>
                    {/* Paused, never deleted: a spent code's redemptions still
                        point at it, and the ledger has to keep reading right. */}
                    <button
                      type="button"
                      onClick={() => toggle(code)}
                      className={`shrink-0 rounded-full px-3.5 py-2 text-sm font-black transition-colors ${
                        code.active
                          ? "bg-cream text-ink/60 hover:bg-ink/10"
                          : "bg-green text-cream"
                      }`}
                    >
                      {code.active ? "Pause" : "Resume"}
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      ) : (
        <div className="mt-3">
          {given.length === 0 ? (
            <p className="mt-6 px-1 text-sm font-bold text-ink/40">
              Nothing given away yet.
            </p>
          ) : (
            <>
              <div className="mb-2 rounded-2xl bg-yellow/25 px-3 py-2.5 text-sm font-black text-ink">
                {rupees(totalGiven)} given across {given.length}{" "}
                {given.length === 1 ? "booking" : "bookings"}
              </div>
              <div className="space-y-1.5">
                {given.map((r) => (
                  <div key={r.id} className="rounded-2xl bg-white p-3 shadow-chunk">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm font-black text-ink">
                        {r.customerName || r.phone || "—"}
                      </span>
                      <span className="shrink-0 text-sm font-black text-green">
                        −{rupees(r.discount)}
                      </span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs font-bold text-ink/50">
                      <span className="tracking-wider text-ink/70">{r.code}</span>
                      <span>{r.invoice || "no invoice"}</span>
                      <span>
                        {rupees(r.gross)} → {rupees(r.net)}
                      </span>
                      <span>{r.channel === "online" ? "self-checkout" : "counter"}</span>
                      <span>{dayTime(r.createdAt)}</span>
                    </div>
                    {(r.appliedByName || r.reason || r.rzpPaymentId) && (
                      <div className="mt-0.5 text-xs font-bold text-ink/35">
                        {r.appliedByName && `by ${r.appliedByName}`}
                        {r.reason && `${r.appliedByName ? " · " : ""}${r.reason}`}
                        {r.rzpPaymentId && ` · ${r.rzpPaymentId}`}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * New code. Deliberately one screen with sensible defaults — the common case is
 * "10% off, unlimited, no end date", and that should be four taps, not a form.
 */
function NewCodeForm({
  staff,
  onCreated,
}: {
  staff: { id: string; name: string }[];
  onCreated: () => void;
}) {
  const [code, setCode] = useState("");
  const [kind, setKind] = useState<"percent" | "flat">("percent");
  const [value, setValue] = useState("");
  const [maxDiscount, setMaxDiscount] = useState("");
  const [minOrder, setMinOrder] = useState("");
  const [usage, setUsage] = useState<DiscountUsage>("multi");
  const [perCustomerLimit, setPerCustomerLimit] = useState("1");
  const [expires, setExpires] = useState("");
  const [channels, setChannels] = useState<("online" | "counter")[]>(["online", "counter"]);
  const [note, setNote] = useState("");
  const [by, setBy] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amount = parseFloat(value);
  const valid =
    code.trim().length >= 3 &&
    !isNaN(amount) &&
    amount > 0 &&
    (kind !== "percent" || amount <= 100) &&
    channels.length > 0 &&
    by.trim().length > 0;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving || !valid) return;
    setSaving(true);
    setError(null);
    try {
      const employee = staff.find((s) => s.name === by);
      const res = await fetch("/api/ops/discounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: code.trim(),
          kind,
          value: amount,
          maxDiscount: maxDiscount.trim() ? parseFloat(maxDiscount) : null,
          minOrder: minOrder.trim() ? parseFloat(minOrder) : 0,
          usage,
          perCustomerLimit: usage === "per_customer" ? parseInt(perCustomerLimit, 10) || 1 : null,
          startsAt: null,
          // A date input is IST midnight to the counter; the end of that day is
          // what "ends 30 Aug" means to a family holding the code.
          expiresAt: expires ? Date.parse(`${expires}T23:59:59+05:30`) : null,
          channels,
          note: note.trim(),
          employeeId: employee?.id,
          employeeName: by,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) {
        window.location.reload();
        return;
      }
      if (!res.ok) throw new Error(body.error || "Couldn't create the code");
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the code");
    } finally {
      setSaving(false);
    }
  };

  const label = "mb-1 block px-1 text-sm font-bold uppercase tracking-widest text-ink/50";
  const field =
    "w-full rounded-2xl border-2 border-ink/10 bg-white px-4 py-3 text-base font-bold text-ink outline-none placeholder:font-bold placeholder:text-ink/30 focus:border-coral";

  return (
    <form onSubmit={submit} className="mt-3 space-y-4 rounded-chunk bg-white p-4 shadow-chunk">
      <div>
        <label className={label}>Code</label>
        <input
          type="text"
          value={code}
          onChange={(e) =>
            setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 24))
          }
          placeholder="PANDA10"
          spellCheck={false}
          className={`${field} font-black tracking-wider`}
        />
      </div>

      <div>
        <label className={label}>Discount</label>
        <div className="flex gap-2">
          <div className="flex shrink-0 gap-1 rounded-full bg-cream p-1">
            {(["percent", "flat"] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                className={`h-9 w-11 rounded-full text-base font-black leading-none transition-colors ${
                  kind === k ? "bg-ink text-cream" : "text-ink/50 hover:bg-ink/10"
                }`}
              >
                {k === "percent" ? "%" : "₹"}
              </button>
            ))}
          </div>
          <input
            type="number"
            inputMode="decimal"
            min={1}
            max={kind === "percent" ? 100 : undefined}
            step="0.01"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={kind === "percent" ? "10" : "100"}
            className={`min-w-0 flex-1 ${field} font-black`}
          />
        </div>
      </div>

      {kind === "percent" && (
        <div>
          <label className={label}>Cap (optional)</label>
          <input
            type="number"
            inputMode="decimal"
            min={1}
            value={maxDiscount}
            onChange={(e) => setMaxDiscount(e.target.value)}
            placeholder="Most it can take off, ₹"
            className={field}
          />
        </div>
      )}

      <div>
        <label className={label}>Minimum booking (optional)</label>
        <input
          type="number"
          inputMode="decimal"
          min={0}
          value={minOrder}
          onChange={(e) => setMinOrder(e.target.value)}
          placeholder="No minimum"
          className={field}
        />
      </div>

      <div>
        <label className={label}>How often</label>
        <div className="flex flex-wrap gap-1.5">
          {USAGE_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => setUsage(o.value)}
              title={o.hint}
              className={`h-10 rounded-full px-4 text-sm font-black transition-colors ${
                usage === o.value ? "bg-ink text-cream" : "bg-cream text-ink/60 hover:bg-ink/10"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
        <p className="mt-1 px-1 text-xs font-bold text-ink/40">
          {USAGE_OPTIONS.find((o) => o.value === usage)?.hint}
        </p>
        {usage === "per_customer" && (
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={100}
            value={perCustomerLimit}
            onChange={(e) => setPerCustomerLimit(e.target.value)}
            className={`mt-2 ${field} font-black`}
          />
        )}
      </div>

      <div>
        <label className={label}>Usable at</label>
        <div className="flex gap-1.5">
          {(
            [
              ["online", "Self-checkout"],
              ["counter", "Counter"],
            ] as const
          ).map(([key, text]) => {
            const on = channels.includes(key);
            return (
              <button
                key={key}
                type="button"
                onClick={() =>
                  setChannels((prev) =>
                    on ? prev.filter((c) => c !== key) : [...prev, key]
                  )
                }
                className={`h-10 flex-1 rounded-full text-sm font-black transition-colors ${
                  on ? "bg-ink text-cream" : "bg-cream text-ink/50 hover:bg-ink/10"
                }`}
              >
                {text}
              </button>
            );
          })}
        </div>
        {/* Marking a code self-checkout-usable is still allowed while the
            customer-facing box is switched off — that's how you get an offer
            ready before launching it — but staff shouldn't hand it out yet. */}
        {!CUSTOMER_CODES_ENABLED && channels.includes("online") && (
          <p className="mt-1 px-1 text-xs font-bold text-ink/40">
            Self-checkout codes are switched off right now — this one will only work at the
            counter until they&apos;re turned back on.
          </p>
        )}
      </div>

      <div>
        <label className={label}>Ends (optional)</label>
        <input
          type="date"
          value={expires}
          onChange={(e) => setExpires(e.target.value)}
          className={field}
        />
      </div>

      <div>
        <label className={label}>Note (optional)</label>
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What it's for"
          className={field}
        />
      </div>

      {staff.length > 0 && (
        <div>
          <label className={label}>Created by</label>
          <div className="relative">
            <select
              value={by}
              onChange={(e) => setBy(e.target.value)}
              className={`${field} cursor-pointer appearance-none pr-10 font-black`}
            >
              <option value="">Who&apos;s creating this?</option>
              {staff.map((s) => (
                <option key={s.id} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
            <span
              aria-hidden
              className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-[10px] font-black text-ink/40"
            >
              ▼
            </span>
          </div>
        </div>
      )}

      {error && <p className="px-1 text-sm font-bold text-coral">{error}</p>}

      <button
        type="submit"
        disabled={saving || !valid}
        className="w-full rounded-full bg-green py-3.5 text-base font-black text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed disabled:opacity-40 disabled:shadow-none"
      >
        {saving ? "Creating…" : "Create code"}
      </button>
    </form>
  );
}
