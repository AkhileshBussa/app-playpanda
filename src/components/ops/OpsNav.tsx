"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAttendanceAlert } from "./useAttendanceAlert";

/**
 * Shared staff-tools header — the one place every ops tool is reachable from.
 *
 * The tools are NOT eight peers, and laying them out that way wrapped the bar
 * onto two rows and got worse with every tool added. They're one live screen
 * plus two groups, so that's what the nav says:
 *
 *   ⏱ Sessions        the all-day screen — always one tap, never in a menu
 *   Customers ▾       who's coming in and what they thought
 *   Operations ▾      what it takes to keep the place running
 *
 * That stays on one row no matter how many tools land in a group. Deliberately
 * not sticky: /ops keeps its own sticky stats header, and two stacked sticky
 * bars fight over the top of the screen.
 */

interface Tool {
  href: string;
  icon: string;
  label: string;
  /** Extra paths that should light this entry up (sub-pages that aren't nested
   *  under its href — e.g. Manage employees hangs off Staff & leave). */
  also?: string[];
}

const SESSIONS: Tool = { href: "/ops", icon: "⏱", label: "Session monitor" };

const GROUPS: { key: string; label: string; short: string; items: Tool[] }[] = [
  {
    key: "customers",
    label: "Customers",
    short: "Cust",
    items: [
      { href: "/members", icon: "🎟", label: "Memberships" },
      { href: "/school", icon: "🎒", label: "School partnerships" },
      { href: "/events", icon: "🎉", label: "Events" },
      { href: "/ops/feedback", icon: "⭐", label: "Customer feedback" },
    ],
  },
  {
    key: "operations",
    label: "Operations",
    short: "Ops",
    items: [
      { href: "/ops/attendance", icon: "🧑‍🤝‍🧑", label: "Staff & leave", also: ["/ops/employees"] },
      { href: "/ops/expenses", icon: "💸", label: "Expenses" },
      { href: "/ops/issues", icon: "🔧", label: "Issues & repairs" },
    ],
  },
];

const under = (pathname: string, href: string) =>
  pathname === href || pathname.startsWith(`${href}/`);

const isActive = (pathname: string, tool: Tool) =>
  under(pathname, tool.href) || (tool.also ?? []).some((p) => under(pathname, p));

export default function OpsNav() {
  const pathname = usePathname();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const navRef = useRef<HTMLElement>(null);
  // Staff who haven't clocked in. Surfaced here as a dot on Operations rather
  // than as a banner on whatever page you're on: it's an HR fact about the day,
  // and it shouldn't interrupt the screen someone opened to do something else.
  const missingAttendance = useAttendanceAlert();

  // Navigating is the end of the interaction — never leave a menu hanging open
  // over the page the user just asked for.
  useEffect(() => setOpenKey(null), [pathname]);

  useEffect(() => {
    if (!openKey) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!navRef.current?.contains(e.target as Node)) setOpenKey(null);
    };
    const onKeyDown = (e: KeyboardEvent) => e.key === "Escape" && setOpenKey(null);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openKey]);

  // /ops is a prefix of half the tools, so the live screen matches exactly —
  // otherwise Sessions would light up on every ops page.
  const sessionsActive = pathname === SESSIONS.href;

  return (
    <header className="border-b-2 border-ink/5 bg-cream print:hidden">
      <nav
        ref={navRef}
        className="mx-auto flex w-full max-w-[1600px] items-center gap-2 px-4 py-2.5 sm:gap-3 lg:px-6"
      >
        <Link href="/ops" aria-label="Play Panda" className="shrink-0">
          <Image
            src="/LogoWithoutBG.png"
            alt="Play Panda"
            width={76}
            height={40}
            className="hidden h-8 w-auto sm:block"
            priority
          />
        </Link>

        <Link
          href={SESSIONS.href}
          aria-current={sessionsActive ? "page" : undefined}
          className={`flex h-10 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-sm font-black transition-colors sm:px-4 ${
            sessionsActive ? "bg-ink text-cream" : "bg-white text-ink/60 hover:bg-ink/10"
          }`}
        >
          <span aria-hidden className="text-base">
            {SESSIONS.icon}
          </span>
          <span className="hidden sm:inline">{SESSIONS.label}</span>
          <span className="sm:hidden">Sessions</span>
        </Link>

        {GROUPS.map((group) => {
          const active = group.items.some((t) => isActive(pathname, t));
          const open = openKey === group.key;
          const alerts = group.key === "operations" ? missingAttendance : [];
          return (
            <div key={group.key} className="relative">
              <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => setOpenKey(open ? null : group.key)}
                className={`relative flex h-10 items-center gap-1.5 rounded-full px-3.5 text-sm font-black transition-colors sm:px-4 ${
                  active
                    ? "bg-ink text-cream"
                    : open
                      ? "bg-ink/10 text-ink"
                      : "bg-white text-ink/60 hover:bg-ink/10"
                }`}
              >
                <span className="hidden sm:inline">{group.label}</span>
                <span className="sm:hidden">{group.short}</span>
                <span
                  aria-hidden
                  className={`text-[10px] leading-none transition-transform ${open ? "rotate-180" : ""}`}
                >
                  ▼
                </span>
                {alerts.length > 0 && (
                  <>
                    <span
                      aria-hidden
                      className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-coral ring-2 ring-cream"
                    />
                    <span className="sr-only">
                      — {alerts.length} needing attention
                    </span>
                  </>
                )}
              </button>

              {open && (
                <>
                  {/* Phones get a bottom sheet — thumbs live at the bottom of
                      the screen, and a tiny anchored dropdown is a hard tap. */}
                  <div
                    className="fixed inset-0 z-40 bg-ink/40 sm:hidden"
                    onClick={() => setOpenKey(null)}
                  />
                  <div
                    role="menu"
                    aria-label={group.label}
                    // The bottom padding clears the iOS home indicator, which
                    // would otherwise sit on top of the last item.
                    //
                    // shadow-chunk's 10px offset is sized for big cards and
                    // reads as a slab under a small menu, so the anchored
                    // dropdown gets a shallower one.
                    className="fixed inset-x-0 bottom-0 z-50 rounded-t-chunk bg-cream p-3 pb-[calc(1.5rem+env(safe-area-inset-bottom))] shadow-chunk sm:absolute sm:inset-x-auto sm:bottom-auto sm:left-0 sm:top-full sm:z-50 sm:mt-1.5 sm:w-64 sm:rounded-2xl sm:border-2 sm:border-ink/5 sm:bg-white sm:p-1.5 sm:shadow-[0_3px_0_0_rgb(0_0_0/0.06)]"
                  >
                    <p className="px-2 pb-2 text-xs font-black uppercase tracking-wide text-ink/40 sm:hidden">
                      {group.label}
                    </p>
                    {/* What the dot means, spelled out — the dot gets you to
                        open the menu, this tells you whether it's worth acting
                        on and takes you straight there. */}
                    {alerts.length > 0 && (
                      <Link
                        href="/ops/attendance"
                        role="menuitem"
                        className="mb-1.5 block rounded-2xl border-2 border-coral/30 bg-coral/10 px-3 py-2 sm:rounded-xl"
                      >
                        <p className="text-sm font-black text-coral">
                          {alerts.length}{" "}
                          {alerts.length === 1 ? "person hasn't" : "people haven't"} marked
                          attendance today
                        </p>
                        <p className="mt-0.5 text-xs font-bold text-ink/50">
                          {alerts.map((a) => a.name).join(", ")}
                        </p>
                      </Link>
                    )}
                    {group.items.map((tool) => {
                      const on = isActive(pathname, tool);
                      return (
                        <Link
                          key={tool.href}
                          href={tool.href}
                          role="menuitem"
                          aria-current={on ? "page" : undefined}
                          className={`flex items-center gap-2.5 rounded-2xl px-3 py-3 text-base font-black transition-colors sm:rounded-xl sm:py-2 sm:text-sm ${
                            on ? "bg-ink text-cream" : "text-ink/70 hover:bg-ink/10"
                          }`}
                        >
                          <span aria-hidden className="text-base">
                            {tool.icon}
                          </span>
                          {tool.label}
                        </Link>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </nav>
    </header>
  );
}
