import type { Metadata } from "next";
import Image from "next/image";
import { isOpsAuthed } from "@/lib/ops/auth";
import OpsLoginGate from "@/components/ops/OpsLoginGate";
import OpsNav from "@/components/ops/OpsNav";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Play Panda — Events",
  robots: { index: false, follow: false },
};

/** Placeholder — the events tool isn't built yet, this just holds its place. */
export default async function EventsPage() {
  if (!(await isOpsAuthed())) return <OpsLoginGate />;

  return (
    <>
      <OpsNav />
      <main className="mx-auto flex w-full max-w-6xl flex-col px-5 pb-16 pt-6">
        <header className="text-center">
          <h1 className="text-2xl font-black leading-tight text-ink">Events</h1>
          <p className="mt-1 text-sm font-bold text-ink/60">
            Parties, group visits and bookings
          </p>
        </header>

        <div className="mt-6 rounded-chunk bg-white p-8 text-center shadow-chunk">
          <Image
            src="/MascotWithoutBG.png"
            alt=""
            width={90}
            height={120}
            className="mx-auto h-24 w-auto opacity-60"
          />
          <p className="mt-4 text-lg font-black text-ink">Nothing here yet</p>
          <p className="mx-auto mt-1 max-w-sm text-sm font-bold text-ink/50">
            This is where the events tool will live. Tell us what the counter needs it to
            do and we&apos;ll build it.
          </p>
        </div>
      </main>
    </>
  );
}
