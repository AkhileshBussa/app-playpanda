/**
 * Wire types for the staff tools — attendance, leave, employees, maintenance
 * issues and customer feedback. Pure and shared by the API routes (producers)
 * and the client pages (consumers); no server-only imports.
 *
 * Days are IST YYYY-MM-DD TEXT (lexicographically comparable) and instants are
 * unix ms, matching the membership store.
 */

// ── Employees ────────────────────────────────────────────────────────────────

export type EmployeeRole = "staff" | "manager";

export interface Employee {
  id: string;
  name: string;
  phone: string;
  role: EmployeeRole;
  /** Inactive employees keep their history but drop off the check-in picker. */
  active: boolean;
  createdAt: number;
}

// ── Attendance ───────────────────────────────────────────────────────────────

/** Where an employee was standing when they tapped, and how far off-site. */
export interface AttendanceFix {
  lat: number;
  lng: number;
  /** Browser-reported accuracy radius, metres. */
  accuracyM: number;
  /** Distance from the playzone, metres. Null only on rows recorded before
   *  the geofence was switched on. */
  distanceM: number | null;
}

export interface AttendanceEntry {
  id: string;
  employeeId: string;
  employeeName: string;
  /** IST day this attendance belongs to. */
  workDate: string;
  checkinAt: number;
  checkin: AttendanceFix;
  checkoutAt: number | null;
  checkout: AttendanceFix | null;
}

/** One row of the manager's day view: the roster joined to today's facts. */
export interface AttendanceRow {
  employee: Employee;
  entry: AttendanceEntry | null;
  /** An approved leave covering this day, if any. */
  onLeave: LeaveRequest | null;
}

// ── Leave ────────────────────────────────────────────────────────────────────

export const LEAVE_TYPES = ["casual", "sick", "holiday"] as const;
export type LeaveType = (typeof LEAVE_TYPES)[number];

export const LEAVE_TYPE_LABELS: Record<LeaveType, string> = {
  casual: "Casual",
  sick: "Sick",
  holiday: "Holiday",
};

export type LeaveStatus = "pending" | "approved" | "rejected";

export interface LeaveRequest {
  id: string;
  employeeId: string;
  employeeName: string;
  /** Inclusive IST range; a single-day leave has fromDate === toDate. */
  fromDate: string;
  toDate: string;
  days: number;
  leaveType: LeaveType;
  reason: string;
  status: LeaveStatus;
  decidedBy: string;
  decidedAt: number | null;
  decisionNote: string;
  createdAt: number;
}

// ── Maintenance issues ───────────────────────────────────────────────────────

export const ISSUE_KINDS = [
  "electrical",
  "plumbing",
  "cleanliness",
  "equipment",
  "ac",
  "other",
] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];

export const ISSUE_KIND_LABELS: Record<IssueKind, string> = {
  electrical: "Electrical",
  plumbing: "Plumbing",
  cleanliness: "Cleanliness",
  equipment: "Play equipment",
  ac: "AC",
  other: "Other",
};

export const ISSUE_KIND_ICONS: Record<IssueKind, string> = {
  electrical: "⚡",
  plumbing: "🚰",
  cleanliness: "🧹",
  equipment: "🎠",
  ac: "❄️",
  other: "🔧",
};

export const ISSUE_PRIORITIES = ["low", "normal", "urgent"] as const;
export type IssuePriority = (typeof ISSUE_PRIORITIES)[number];

export const ISSUE_STATUSES = ["open", "in_progress", "resolved"] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const ISSUE_STATUS_LABELS: Record<IssueStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  resolved: "Resolved",
};

export interface MaintenanceIssue {
  id: string;
  kind: IssueKind;
  title: string;
  details: string;
  priority: IssuePriority;
  status: IssueStatus;
  /** Blob URL of the photo, or "" when none was attached. */
  photoUrl: string;
  reportedByName: string;
  createdAt: number;
  resolvedAt: number | null;
  resolutionNote: string;
}

// ── Customer feedback ────────────────────────────────────────────────────────

export interface Feedback {
  id: string;
  /** 1–5 stars. */
  rating: number;
  /** What could be improved — only asked for below 5 stars. */
  improve: string;
  name: string;
  phone: string;
  /** True once a 5-star rater was handed off to the Google review page. */
  sentToGoogle: boolean;
  createdAt: number;
}
