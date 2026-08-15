"use client";

import { useEffect, useState } from "react";
import { formatInr } from "@/lib/pricing";
import type { OpsSession } from "@/lib/ops/types";

interface ApplyDiscountSheetProps {
  session: OpsSession;
  onClose: () => void;
  /** Discount landed; carries the new balance so the card can update. */
  onApplied: (session: OpsSession, net: number) => void;
}

const inr = formatInr;

/**
 * Discount an invoice at the counter — the family that booked on the app and
 * then asked at the desk.
 *
 * Two ways in, because both happen: a code someone was given, or a one-off "₹100
 * off" a manager decides on the spot. The one-off is the default tab: it's the
 * common case, and making it the thing you have to hunt for would push staff
 * back to doing it in Swipe where nothing gets recorded.
 */
export default function ApplyDiscountSheet({
  session,
  onClose,
  onApplied,
}: ApplyDiscountSheetProps) {
  const due = session.amountDue;
  const [mode, setMode] = useState<"oneoff" | "code">("oneoff");
  const [kind, setKind] = useState<"flat" | "percent">("flat");
  const [value, setValue] = useState("");
  const [code, setCode] = useState("");
  const [reason, setReason] = useState("");
  const [staff, setStaff] = useState<{ id: string; name: string }[]>([]);
  const [by, setBy] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Who's granting it. Same stand-in for per-employee login as the expense
  // form: whoever's at the counter picks their name off the roster.
  useEffect(() => {
    fetch("/api/ops/employees")
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        const list = (body?.employees ?? [])
          .filter((e: { active: boolean }) => e.active)
          .map((e: { id: string; name: string }) => ({ id: e.id, name: e.name }));
        setStaff(list);
      })
      .catch(() => {});
  }, []);

  const amount = parseFloat(value);
  const preview =
    !isNaN(amount) && amount > 0
      ? kind === "percent"
        ? Math.min(Math.round(((due * amount) / 100) * 100) / 100, due)
        : Math.min(amount, due)
      : 0;

  const valid =
    by.trim().length > 0 &&
    (mode === "code"
      ? code.trim().length > 0
      : !isNaN(amount) && amount > 0 && (kind !== "percent" || amount <= 100));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving || !valid) return;
    setSaving(true);
    setError(null);
    try {
      const employee = staff.find((s) => s.name === by);
      const res = await fetch("/api/ops/discounts/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          invoiceNumber: session.invoiceNumber,
          ...(mode === "code"
            ? { code: code.trim().toUpperCase() }
            : { kind, value: amount }),
          reason: reason.trim(),
          phone: session.phone,
          customerName: session.parentName,
          employeeId: employee?.id,
          employeeName: by,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        window.location.reload();
        return;
      }
      if (!res.ok) throw new Error(data.error || "Couldn't apply the discount");
      onApplied(session, Number(data.net ?? due));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't apply the discount");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-ink/40" onClick={saving ? undefined : onClose} />

      <div className="relative mx-4 w-full max-w-md rounded-t-chunk bg-cream p-6 shadow-chunk sm:rounded-chunk">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-xl font-black text-ink">Apply discount</h2>
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
          <div className="flex gap-2">
            {(
              [
                ["oneoff", "One-off amount"],
                ["code", "Use a code"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  setMode(key);
                  setError(null);
                }}
                className={`h-11 flex-1 rounded-full text-sm font-black leading-none transition-colors ${
                  mode === key ? "bg-ink text-cream" : "bg-white text-ink/60 hover:bg-ink/10"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {mode === "code" ? (
            <div>
              <label className="mb-1 block px-1 text-sm font-bold uppercase tracking-widest text-ink/50">
                Code
              </label>
              <input
                type="text"
                value={code}
                onChange={(e) =>
                  setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 24))
                }
                placeholder="SCHOOL10"
                autoCapitalize="characters"
                spellCheck={false}
                className="w-full rounded-2xl border-2 border-ink/10 bg-white px-4 py-3 text-base font-black tracking-wider text-ink outline-none placeholder:font-bold placeholder:tracking-normal placeholder:text-ink/30 focus:border-coral"
              />
              <p className="mt-1 px-1 text-xs font-bold text-ink/50">
                The code&apos;s own limits still apply — a single-use code that&apos;s already
                been used will be refused.
              </p>
            </div>
          ) : (
            <div>
              <label className="mb-1 block px-1 text-sm font-bold uppercase tracking-widest text-ink/50">
                Discount
              </label>
              <div className="flex gap-2">
                <div className="flex shrink-0 gap-1 rounded-full bg-white p-1">
                  {(["flat", "percent"] as const).map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setKind(k)}
                      className={`h-9 w-11 rounded-full text-base font-black leading-none transition-colors ${
                        kind === k ? "bg-ink text-cream" : "text-ink/50 hover:bg-ink/10"
                      }`}
                    >
                      {k === "flat" ? "₹" : "%"}
                    </button>
                  ))}
                </div>
                <input
                  type="number"
                  inputMode="decimal"
                  min={1}
                  max={kind === "percent" ? 100 : due}
                  step="0.01"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder={kind === "percent" ? "10" : "100"}
                  className="min-w-0 flex-1 rounded-2xl border-2 border-ink/10 bg-white px-4 py-3 text-base font-black text-ink outline-none placeholder:font-bold placeholder:text-ink/30 focus:border-coral"
                />
              </div>
              {preview > 0 && (
                <p className="mt-1 px-1 text-xs font-bold text-ink/50">
                  {inr(preview)} off — new total {inr(Math.round((due - preview) * 100) / 100)}
                </p>
              )}
            </div>
          )}

          <div>
            <label className="mb-1 block px-1 text-sm font-bold uppercase tracking-widest text-ink/50">
              Reason {mode === "code" ? "(optional)" : ""}
            </label>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Regular family, birthday, service issue…"
              className="w-full rounded-2xl border-2 border-ink/10 bg-white px-4 py-3 text-base font-bold text-ink outline-none placeholder:font-bold placeholder:text-ink/30 focus:border-coral"
            />
          </div>

          {staff.length > 0 && (
            <div>
              <label className="mb-1 block px-1 text-sm font-bold uppercase tracking-widest text-ink/50">
                Applied by
              </label>
              <div className="relative">
                <select
                  value={by}
                  onChange={(e) => setBy(e.target.value)}
                  className="w-full cursor-pointer appearance-none rounded-2xl border-2 border-ink/10 bg-white py-3 pl-4 pr-10 text-base font-black text-ink outline-none focus:border-coral"
                >
                  <option value="">Who&apos;s applying this?</option>
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
            className="w-full rounded-full bg-coral py-3.5 text-base font-black text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed disabled:opacity-40 disabled:shadow-none"
          >
            {saving
              ? "Applying…"
              : mode === "code"
                ? "Apply code"
                : `Take ${inr(preview)} off`}
          </button>
          <p className="px-1 text-center text-xs font-bold text-ink/40">
            The invoice is re-priced in Swipe and the discount is recorded against{" "}
            {by || "whoever applies it"}.
          </p>
        </form>
      </div>
    </div>
  );
}
