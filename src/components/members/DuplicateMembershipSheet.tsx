"use client";

import { playsLeft, type Membership } from "@/lib/members/types";

interface DuplicateMembershipSheetProps {
  existing: Membership;
  activeCount: number;
  samePlan: boolean;
  planName: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

const longDate = (date: string) =>
  new Date(`${date}T12:00:00+05:30`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });

export default function DuplicateMembershipSheet({
  existing,
  activeCount,
  samePlan,
  planName,
  busy,
  onCancel,
  onConfirm,
}: DuplicateMembershipSheetProps) {
  const left = playsLeft(existing);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-ink/40" onClick={busy ? undefined : onCancel} />

      <div className="relative mx-4 w-full max-w-md rounded-t-chunk bg-cream p-6 shadow-chunk sm:rounded-chunk">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-xl font-black text-ink">Already a member</h2>
          <button
            onClick={onCancel}
            disabled={busy}
            className="text-2xl leading-none text-ink/40 hover:text-ink disabled:opacity-40"
            aria-label="Cancel"
          >
            &times;
          </button>
        </div>
        <p className="text-sm font-bold text-ink/60">
          {existing.customerName || existing.phone} already has{" "}
          {activeCount > 1 ? `${activeCount} active memberships` : "an active membership"}.
        </p>

        <div className="mt-3 rounded-2xl bg-white px-3 py-2 text-sm font-bold text-ink/70">
          <p className="font-black text-ink">{existing.planName}</p>
          <p>
            Valid till {longDate(existing.expiresOn)}
            {left != null ? ` · ${left} play${left === 1 ? "" : "s"} left` : " · unlimited plays"}
          </p>
          {existing.saleInvoiceNumber && <p>Billed on {existing.saleInvoiceNumber}</p>}
        </div>

        <p className="mt-3 px-1 text-sm font-bold text-ink/70">
          {samePlan
            ? `Create another ${planName} on top of this one?`
            : `Create a ${planName} alongside it?`}{" "}
          The counter will see both, and plays come off whichever is punched.
        </p>

        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="flex-1 rounded-full bg-white py-3 text-base font-black text-ink transition-all active:translate-y-0.5 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="flex-1 rounded-full bg-coral py-3 text-base font-black text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed disabled:opacity-40 disabled:shadow-none"
          >
            {busy ? "Saving…" : "Create anyway"}
          </button>
        </div>
      </div>
    </div>
  );
}
