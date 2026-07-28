"use client";

import { useState } from "react";
import { saveManualVisit } from "@/lib/ops/manual";

interface AddVisitProps {
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
}

/** Modal to add a membership visit by hand (no invoice). Timer starts now. */
export default function AddVisit({ open, onClose, onAdded }: AddVisitProps) {
  const [kidName, setKidName] = useState("");
  const [parentName, setParentName] = useState("");
  const [phone, setPhone] = useState("");
  const [hours, setHours] = useState(0);

  if (!open) return null;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!kidName.trim()) return;

    saveManualVisit({
      kidName: kidName.trim(),
      parentName: parentName.trim(),
      phone: phone.trim(),
      hours,
    });

    setKidName("");
    setParentName("");
    setPhone("");
    setHours(0);
    onAdded();
    onClose();
  }

  const inputClass =
    "w-full rounded-2xl border-2 border-ink/10 bg-cream/60 px-4 py-3 text-base font-bold text-ink outline-none placeholder:font-bold placeholder:text-ink/30 focus:border-coral";

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-ink/40" onClick={onClose} />

      <div className="relative mx-4 w-full max-w-md rounded-t-chunk bg-cream p-6 shadow-chunk sm:rounded-chunk">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-xl font-black text-ink">Membership visit</h2>
          <button
            onClick={onClose}
            className="text-2xl leading-none text-ink/40 hover:text-ink"
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block px-1 text-sm font-bold uppercase tracking-widest text-ink/50">
              Kid name *
            </label>
            <input
              type="text"
              value={kidName}
              onChange={(e) => setKidName(e.target.value)}
              placeholder="e.g. Nihira"
              className={inputClass}
              autoFocus
              required
            />
          </div>

          <div>
            <label className="mb-1 block px-1 text-sm font-bold uppercase tracking-widest text-ink/50">
              Duration
            </label>
            <div className="flex gap-2">
              {[
                { value: 1, label: "1 hr" },
                { value: 2, label: "2 hr" },
                { value: 3, label: "3 hr" },
                { value: 0, label: "Open" },
              ].map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setHours(opt.value)}
                  className={`flex-1 rounded-full py-2.5 text-base font-black transition-colors ${
                    hours === opt.value
                      ? "bg-ink text-cream"
                      : "bg-white text-ink/60 hover:bg-ink/10"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-1 block px-1 text-sm font-bold uppercase tracking-widest text-ink/50">
              Parent name
            </label>
            <input
              type="text"
              value={parentName}
              onChange={(e) => setParentName(e.target.value)}
              placeholder="e.g. Raghav"
              className={inputClass}
            />
          </div>

          <div>
            <label className="mb-1 block px-1 text-sm font-bold uppercase tracking-widest text-ink/50">
              Phone number
            </label>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="e.g. 9959060208"
              className={inputClass}
            />
          </div>

          <button
            type="submit"
            className="w-full rounded-full bg-coral py-3.5 text-base font-black text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed"
          >
            Start visit
          </button>
        </form>
      </div>
    </div>
  );
}
