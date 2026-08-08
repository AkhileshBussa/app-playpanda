import type { Metadata } from "next";
import StaffApp from "@/components/staff/StaffApp";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Play Panda — Staff",
  robots: { index: false, follow: false },
};

/**
 * Employee self-service: mark attendance, apply for leave.
 *
 * Not behind the shared ops password on purpose — each employee signs in with
 * their own 4-digit PIN, so nobody needs the manager's credential to record
 * their own day, and every entry is attributable.
 */
export default function StaffPage() {
  return <StaffApp />;
}
