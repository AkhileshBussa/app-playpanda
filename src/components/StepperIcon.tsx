/**
 * The −/+ inside stepper buttons, drawn rather than typed: HankRnd's plus and
 * minus glyphs sit high in their line box, so centring them as text leaves
 * them visibly off-centre inside a round button. An SVG centres exactly.
 * Inherits its colour from the button (currentColor).
 */
export default function StepperIcon({ kind }: { kind: "plus" | "minus" }) {
  return (
    <svg viewBox="0 0 12 12" className="h-3.5 w-3.5" fill="none" aria-hidden>
      <path
        d={kind === "plus" ? "M2 6h8M6 2v8" : "M2 6h8"}
        stroke="currentColor"
        strokeWidth={2.4}
        strokeLinecap="round"
      />
    </svg>
  );
}
