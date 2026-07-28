import Image from "next/image";
import { billing } from "@/lib/billing";

export const dynamic = "force-dynamic";

/**
 * Confirmation screen the customer shows at the counter. Keyed by the invoice
 * number in the URL and driven entirely by the billing backend (reload-safe,
 * no dependency on ephemeral query params). The manager validates the 4-digit
 * code, which is read back from the invoice's "Validation Code" field.
 */
export default async function SuccessPage({
  params,
}: {
  params: Promise<{ invoice: string }>;
}) {
  const { invoice } = await params;

  let booking = null;
  try {
    booking = await billing.getBookingByInvoiceNumber(invoice);
  } catch (err) {
    console.error("failed to load booking:", err);
  }

  if (!booking) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center px-6 text-center">
        <div className="text-5xl">🐼</div>
        <h1 className="mt-4 text-2xl font-black text-ink">Booking not found</h1>
        <p className="mt-2 text-sm font-bold text-ink/60">
          We couldn&apos;t find invoice {invoice}. Please check with the counter — they can look it
          up by your mobile number.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center px-6 pb-10 pt-14 text-center">
      <div
        className={`grid h-24 w-24 place-items-center rounded-full text-5xl shadow-chunk ${
          booking.paid ? "bg-green" : "bg-yellow"
        }`}
      >
        {booking.paid ? <span className="text-cream">✓</span> : "🎟️"}
      </div>

      <h1 className="mt-6 text-3xl font-black leading-[1.05] text-ink">
        {booking.paid ? "You're in!" : "You're booked!"}
      </h1>
      <p className="mt-2 text-sm font-bold text-ink/60">
        {booking.paid
          ? "Show this screen at the counter and jump right in."
          : "Show this at the counter, pay, and jump right in."}
      </p>

      {/* Validation code — the hero the manager matches against the invoice. */}
      {booking.validationCode && (
        <div className="mt-8 w-full rounded-chunk bg-ink p-6 text-center shadow-chunk">
          <div className="text-xs font-bold uppercase tracking-widest text-cream/60">
            Show this code at the counter
          </div>
          <div className="mt-2 text-6xl font-black tracking-[0.2em] text-cream tabular-nums">
            {booking.validationCode}
          </div>
        </div>
      )}

      <div className="mt-4 w-full rounded-chunk bg-white p-6 shadow-chunk">
        <div className="text-xs font-bold uppercase tracking-widest text-ink/40">Invoice number</div>
        <div className="mt-1 text-3xl font-black tracking-tight text-coral">{booking.invoiceNumber}</div>

        <div className="mt-5 space-y-2 border-t border-dashed border-ink/10 pt-4 text-left text-sm">
          {booking.customerName && <Row label="Name" value={booking.customerName} />}
          {booking.lines.map((line, i) => (
            <Row key={i} label={i === 0 ? "Items" : ""} value={`${line.name} × ${line.quantity}`} />
          ))}
          <Row
            label={booking.paid ? "Paid" : "To pay"}
            value={`₹${booking.amount.toLocaleString("en-IN")}`}
          />
        </div>
      </div>

      {!booking.paid && (
        <p className="mt-4 rounded-chunk bg-yellow/25 px-4 py-3 text-sm font-bold text-ink/80">
          Your booking is saved. Please pay ₹{booking.amount.toLocaleString("en-IN")} at the counter
          to confirm your spot.
        </p>
      )}

      <div className="mt-auto pt-10">
        <Image src="/MascotWithoutBG.png" alt="" width={72} height={96} className="mx-auto h-20 w-auto" />
        <p className="mt-2 text-sm font-black text-ink/60">Have a blast at Play Panda!</p>
      </div>
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="shrink-0 font-bold text-ink/50">{label}</span>
      <span className="truncate font-black text-ink">{value}</span>
    </div>
  );
}
