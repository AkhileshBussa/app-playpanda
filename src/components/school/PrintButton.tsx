"use client";

/** Opens the browser print dialog — for handing the roster to the school. */
export default function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="rounded-full bg-ink px-5 py-2.5 text-sm font-black text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed print:hidden"
    >
      Print / save PDF
    </button>
  );
}
