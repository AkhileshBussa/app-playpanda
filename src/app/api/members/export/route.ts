import { NextResponse } from "next/server";
import { isOpsAuthed } from "@/lib/ops/auth";
import { todayIST } from "@/lib/ops/state";
import { listAllMemberships, listAllVisits, membersDbConfigured } from "@/lib/members/db";
import { membershipStatus, playsLeft } from "@/lib/members/types";

export const dynamic = "force-dynamic";

const csvCell = (v: string | number | null | undefined): string => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const csv = (rows: (string | number | null | undefined)[][]): string =>
  rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";

const istDateTime = (ms: number) =>
  new Date(ms).toLocaleString("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: true,
    timeZone: "Asia/Kolkata",
  });

/** CSV download of all memberships (default) or all visits (?what=visits). */
export async function GET(req: Request) {
  if (!(await isOpsAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!membersDbConfigured()) {
    return NextResponse.json({ error: "Membership database not set up yet" }, { status: 503 });
  }

  const what = new URL(req.url).searchParams.get("what") === "visits" ? "visits" : "memberships";
  const today = todayIST();

  try {
    let body: string;
    if (what === "visits") {
      const visits = await listAllVisits();
      body = csv([
        ["Visited at (IST)", "Date", "Phone", "Kids in", "Plays used", "Kid names",
         "Punch invoice", "Deleted at (IST)", "Deleted reason", "Membership ID"],
        ...visits.map((v) => [
          istDateTime(v.visitedAt), v.visitDate, v.phone, v.kidsCount, v.playsUsed,
          v.kidNames, v.punchInvoiceNumber,
          v.deletedAt ? istDateTime(v.deletedAt) : "", v.deletedReason, v.membershipId,
        ]),
      ]);
    } else {
      const memberships = await listAllMemberships();
      body = csv([
        ["Created at (IST)", "Phone", "Customer", "Kids", "Plan", "Status", "Plays used",
         "Plays left", "Total plays", "Hours/play", "Kids/play", "Starts", "Expires",
         "Price (₹)", "Sale invoice", "Notes", "Deleted at (IST)", "Deleted reason",
         "Membership ID"],
        ...memberships.map((m) => [
          istDateTime(m.createdAt), m.phone, m.customerName, m.kidNames, m.planName,
          membershipStatus(m, today), m.playsUsed, playsLeft(m) ?? "Unlimited",
          m.totalPlays ?? "Unlimited", m.hoursPerPlay, m.kidsPerPlay, m.startsOn,
          m.expiresOn, m.priceInr ?? "", m.saleInvoiceNumber, m.notes,
          m.deletedAt ? istDateTime(m.deletedAt) : "", m.deletedReason, m.id,
        ]),
      ]);
    }

    return new NextResponse(body, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="playpanda-${what}-${today}.csv"`,
      },
    });
  } catch (err) {
    console.error("members export failed:", err);
    return NextResponse.json({ error: "Export failed — please try again" }, { status: 502 });
  }
}
