"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Shared staff-tools header — the one place every ops tool is reachable from,
 * so the pages stop needing ad-hoc cross-links in their body. Deliberately not
 * sticky: /ops keeps its own sticky stats header, and two stacked sticky bars
 * fight over the top of the screen.
 */
const TOOLS = [
  { href: "/ops", icon: "⏱", label: "Session monitor", short: "Sessions" },
  { href: "/members", icon: "🎟", label: "Membership management", short: "Members" },
  { href: "/school", icon: "🎒", label: "School partnerships", short: "School" },
  { href: "/events", icon: "🎉", label: "Events", short: "Events" },
];

export default function OpsNav() {
  const pathname = usePathname();

  return (
    <header className="border-b-2 border-ink/5 bg-cream print:hidden">
      <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 py-2.5">
        <Image
          src="/LogoWithoutBG.png"
          alt="Play Panda"
          width={76}
          height={40}
          className="hidden h-8 w-auto shrink-0 sm:block"
          priority
        />
        {/* Phones get a 4-up tab bar (all tools visible, no sideways scroll);
            from sm up it relaxes into a row of full-label pills. */}
        <nav className="grid min-w-0 flex-1 grid-cols-4 gap-1.5 sm:flex">
          {TOOLS.map((tool) => {
            const active = pathname === tool.href || pathname.startsWith(`${tool.href}/`);
            return (
              <Link
                key={tool.href}
                href={tool.href}
                aria-current={active ? "page" : undefined}
                className={`flex flex-col items-center justify-center gap-0.5 rounded-2xl px-1 py-1.5 text-[11px] font-black leading-none transition-colors sm:h-10 sm:shrink-0 sm:flex-row sm:gap-1.5 sm:whitespace-nowrap sm:rounded-full sm:px-4 sm:text-sm ${
                  active ? "bg-ink text-cream" : "bg-white text-ink/60 hover:bg-ink/10"
                }`}
              >
                <span aria-hidden className="text-sm sm:text-base">
                  {tool.icon}
                </span>
                <span className="hidden sm:inline">{tool.label}</span>
                <span className="sm:hidden">{tool.short}</span>
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
