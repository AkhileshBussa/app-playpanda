/**
 * Manual membership visits — sessions the manager adds by hand (member kids
 * whose visit isn't billed through an invoice). Client-side only: stored in
 * this device's localStorage, scoped to today, exactly like pp-billing.
 * Check-out state still goes through Redis so it survives reloads.
 */

import type { OpsSession } from "./types";

export interface ManualVisit {
  id: string; // "manual-<ts>"
  phone: string;
  parentName: string;
  kidName: string;
  hours: number; // 0 = unlimited
  startTime: number; // unix ms
  date: string; // YYYY-MM-DD (local)
}

const STORAGE_KEY = "pp-ops-manual-visits";

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

export function getManualVisits(): ManualVisit[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const all: ManualVisit[] = JSON.parse(raw);
    const today = todayKey();
    const todays = all.filter((v) => v.date === today);
    if (todays.length !== all.length) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(todays));
    }
    return todays;
  } catch {
    return [];
  }
}

export function saveManualVisit(visit: Omit<ManualVisit, "id" | "startTime" | "date">): void {
  const visits = getManualVisits();
  visits.push({ ...visit, id: `manual-${Date.now()}`, startTime: Date.now(), date: todayKey() });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(visits));
}

/** Shape a manual visit like an API session so one card component renders both. */
export function manualToOpsSession(
  v: ManualVisit,
  checkouts: Record<string, number>
): OpsSession {
  return {
    id: v.id,
    invoiceNumber: "Membership",
    kidNames: [v.kidName],
    parentName: v.parentName,
    phone: v.phone,
    bookedAt: v.startTime,
    durationMinutes: v.hours * 60,
    products: [v.hours ? `Membership - ${v.hours}hr` : "Membership Visit"],
    kidCount: 1,
    isMembership: true,
    paid: true,
    amountDue: 0,
    needsCheckIn: false,
    checkinAt: null,
    checkoutAt: checkouts[v.id] ?? null,
    isManual: true,
  };
}
