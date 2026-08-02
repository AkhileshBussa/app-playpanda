"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Section nav for the memberships tool. Punching and creating are separate
 * jobs: the counter needs a lookup, creating a membership does not.
 */
const TABS = [
  { href: "/members", label: "Punch a visit", short: "Punch" },
  { href: "/members/new", label: "New membership", short: "New" },
  { href: "/members/list", label: "All members", short: "All" },
];

export default function MembersTabs() {
  const pathname = usePathname();

  return (
    <div className="flex gap-1.5">
      {TABS.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={`flex h-9 items-center whitespace-nowrap rounded-full px-4 text-sm font-black leading-none transition-colors ${
              active ? "bg-teal text-cream" : "bg-white text-ink/60 hover:bg-ink/10"
            }`}
          >
            {/* Three full labels overflow a phone; short ones fit. */}
            <span className="hidden sm:inline">{tab.label}</span>
            <span className="sm:hidden">{tab.short}</span>
          </Link>
        );
      })}
    </div>
  );
}
