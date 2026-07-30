import type { Metadata } from "next";
import Link from "next/link";
import { isOpsAuthed } from "@/lib/ops/auth";
import { listSchoolKids, type SchoolKidEntry } from "@/lib/school";
import { todayIST } from "@/lib/ops/state";
import OpsLoginGate from "@/components/ops/OpsLoginGate";
import AutoRefresh from "@/components/success/AutoRefresh";
import PrintButton from "@/components/school/PrintButton";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Play Panda — Student List",
  robots: { index: false, follow: false },
};

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

const timeIST = (ms: number) =>
  new Date(ms).toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });

/**
 * Read-only student roster for a school visit — the review/share counterpart
 * of the /school note-taking page. Defaults to today; ?date=YYYY-MM-DD (or the
 * date picker) shows an earlier visit. Print-friendly for handing the list to
 * the school.
 */
export default async function SchoolListPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  if (!(await isOpsAuthed())) return <OpsLoginGate />;

  const { date: rawDate } = await searchParams;
  const today = todayIST();
  const date = rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : today;
  const isToday = date === today;

  let entries: SchoolKidEntry[] = [];
  let loadError = false;
  try {
    entries = await listSchoolKids(date);
  } catch (err) {
    console.error("failed to load school list:", err);
    loadError = true;
  }

  // Group by class (case-insensitive), classes in natural order, kids in
  // arrival order — same view the note-taking page shows.
  const byClass = new Map<string, { label: string; kids: SchoolKidEntry[] }>();
  for (const entry of entries) {
    const key = norm(entry.className);
    const group = byClass.get(key) ?? { label: entry.className, kids: [] };
    group.kids.push(entry);
    byClass.set(key, group);
  }
  const groups = [...byClass.values()].sort((a, b) =>
    a.label.localeCompare(b.label, "en", { numeric: true })
  );

  const prettyDate = new Date(`${date}T12:00:00+05:30`).toLocaleDateString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 pb-16 pt-6 print:max-w-none">
      {/* While viewing today's visit, keep the roster live as staff add kids. */}
      {isToday && <AutoRefresh intervalMs={10_000} />}

      <header>
        <h1 className="text-2xl font-black leading-tight text-ink">Student list</h1>
        <p className="mt-1 text-sm font-bold text-ink/60">
          Play Panda school visit · {prettyDate}
        </p>
      </header>

      {/* Controls — not part of the printed roster */}
      <div className="mt-4 flex flex-wrap items-center gap-2 print:hidden">
        <form method="GET" className="flex items-center gap-2">
          <input
            type="date"
            name="date"
            defaultValue={date}
            max={today}
            className="rounded-2xl border-2 border-ink/10 bg-white px-3 py-2 text-sm font-bold text-ink outline-none focus:border-coral"
          />
          <button
            type="submit"
            className="rounded-full bg-coral px-5 py-2.5 text-sm font-black text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed"
          >
            View
          </button>
        </form>
        <PrintButton />
        <Link
          href="/school"
          className="ml-auto text-sm font-black text-green underline underline-offset-2"
        >
          ✏️ Note kids
        </Link>
      </div>

      {/* Summary */}
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-green px-3 py-1 text-sm font-black text-cream">
          {entries.length} student{entries.length === 1 ? "" : "s"}
        </span>
        {groups.map((g) => (
          <span
            key={g.label}
            className="rounded-full bg-white px-3 py-1 text-xs font-black text-ink/70 shadow-[0_2px_0_rgba(0,0,0,0.06)]"
          >
            {g.label} · {g.kids.length}
          </span>
        ))}
      </div>

      {loadError ? (
        <p className="mt-8 text-center text-sm font-bold text-coral">
          Couldn&apos;t load the list — please refresh.
        </p>
      ) : entries.length === 0 ? (
        <p className="mt-8 text-center text-sm font-bold text-ink/40">
          No students noted on this day{isToday ? " yet" : ""}.
        </p>
      ) : (
        <div className="mt-5 flex flex-col gap-4">
          {groups.map((group) => (
            <section
              key={group.label}
              className="rounded-chunk bg-white p-4 shadow-chunk print:break-inside-avoid print:rounded-none print:p-2 print:shadow-none"
            >
              <div className="flex items-baseline justify-between border-b border-ink/10 pb-2">
                <h2 className="text-sm font-black uppercase tracking-widest text-coral">
                  Class {group.label}
                </h2>
                <span className="text-xs font-black text-ink/50">
                  {group.kids.length} student{group.kids.length === 1 ? "" : "s"}
                </span>
              </div>
              <ol className="mt-1 divide-y divide-ink/5">
                {group.kids.map((entry, i) => (
                  <li key={entry.id} className="flex items-center gap-3 py-2">
                    <span className="w-6 shrink-0 text-right text-xs font-black text-ink/30 tabular-nums">
                      {i + 1}.
                    </span>
                    <span className="min-w-0 flex-1 truncate text-base font-black text-ink">
                      {entry.kidName}
                    </span>
                    <span className="shrink-0 text-xs font-bold text-ink/40">
                      {timeIST(entry.at)}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
