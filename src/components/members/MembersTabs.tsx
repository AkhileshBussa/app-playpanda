"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Section nav for the memberships tool: the counter vs the full ledger. */
const TABS = [
  { href: "/members", label: "Counter" },
  { href: "/members/list", label: "All members" },
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
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
