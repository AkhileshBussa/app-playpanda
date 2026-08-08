/**
 * Staff-tools store — employees, attendance, leave, maintenance issues and
 * customer feedback, in the same Postgres as memberships.
 *
 * Expenses are deliberately absent: those live in Swipe (see ./expenses.ts) so
 * the books stay in one place, exactly as when the counter billed them by hand.
 */

import { randomUUID } from "node:crypto";
import { getPool, onceSchema } from "../pg";
import type {
  AttendanceEntry,
  AttendanceFix,
  AttendanceRow,
  Employee,
  EmployeeRole,
  Feedback,
  IssueKind,
  IssuePriority,
  IssueStatus,
  LeaveRequest,
  LeaveStatus,
  LeaveType,
  MaintenanceIssue,
} from "./types";

const ensureSchema = onceSchema(`
  CREATE TABLE IF NOT EXISTS employees (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'staff',
    pin_hash TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at BIGINT NOT NULL
  );

  -- One row per employee per IST day; the unique index is what stops a double
  -- check-in when two taps race.
  CREATE TABLE IF NOT EXISTS attendance (
    id TEXT PRIMARY KEY,
    employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    work_date TEXT NOT NULL,
    checkin_at BIGINT NOT NULL,
    checkin_lat DOUBLE PRECISION NOT NULL,
    checkin_lng DOUBLE PRECISION NOT NULL,
    checkin_accuracy_m DOUBLE PRECISION NOT NULL,
    checkin_distance_m DOUBLE PRECISION,
    checkout_at BIGINT,
    checkout_lat DOUBLE PRECISION,
    checkout_lng DOUBLE PRECISION,
    checkout_accuracy_m DOUBLE PRECISION,
    checkout_distance_m DOUBLE PRECISION
  );
  CREATE UNIQUE INDEX IF NOT EXISTS attendance_employee_day_idx
    ON attendance (employee_id, work_date);
  CREATE INDEX IF NOT EXISTS attendance_day_idx ON attendance (work_date);

  CREATE TABLE IF NOT EXISTS leave_requests (
    id TEXT PRIMARY KEY,
    employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    from_date TEXT NOT NULL,
    to_date TEXT NOT NULL,
    leave_type TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    decided_by TEXT NOT NULL DEFAULT '',
    decided_at BIGINT,
    decision_note TEXT NOT NULL DEFAULT '',
    created_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS leave_employee_idx ON leave_requests (employee_id);
  CREATE INDEX IF NOT EXISTS leave_range_idx ON leave_requests (from_date, to_date);

  CREATE TABLE IF NOT EXISTS maintenance_issues (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL DEFAULT 'normal',
    status TEXT NOT NULL DEFAULT 'open',
    photo_url TEXT NOT NULL DEFAULT '',
    reported_by_name TEXT NOT NULL DEFAULT '',
    created_at BIGINT NOT NULL,
    resolved_at BIGINT,
    resolution_note TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS issues_status_idx ON maintenance_issues (status);

  CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY,
    rating INTEGER NOT NULL,
    improve TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    sent_to_google BOOLEAN NOT NULL DEFAULT FALSE,
    created_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS feedback_created_idx ON feedback (created_at);
`);

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Employees ────────────────────────────────────────────────────────────────

function toEmployee(r: any): Employee {
  return {
    id: r.id,
    name: r.name,
    phone: r.phone,
    role: r.role as EmployeeRole,
    active: r.active,
    createdAt: Number(r.created_at),
  };
}

export async function listEmployees(includeInactive = false): Promise<Employee[]> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT * FROM employees ${includeInactive ? "" : "WHERE active"} ORDER BY active DESC, name`
  );
  return rows.map(toEmployee);
}

export async function getEmployee(id: string): Promise<Employee | null> {
  await ensureSchema();
  const { rows } = await getPool().query(`SELECT * FROM employees WHERE id = $1`, [id]);
  return rows[0] ? toEmployee(rows[0]) : null;
}

/** The stored hash, for PIN verification. Never leaves the server. */
export async function getEmployeePinHash(id: string): Promise<string | null> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT pin_hash FROM employees WHERE id = $1 AND active`,
    [id]
  );
  return rows[0]?.pin_hash ?? null;
}

export async function createEmployee(input: {
  name: string;
  phone: string;
  role: EmployeeRole;
  pinHash: string;
}): Promise<Employee> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `INSERT INTO employees (id, name, phone, role, pin_hash, active, created_at)
     VALUES ($1,$2,$3,$4,$5,TRUE,$6) RETURNING *`,
    [randomUUID(), input.name, input.phone, input.role, input.pinHash, Date.now()]
  );
  return toEmployee(rows[0]);
}

export async function updateEmployee(
  id: string,
  patch: { name?: string; phone?: string; role?: EmployeeRole; active?: boolean; pinHash?: string }
): Promise<Employee | null> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `UPDATE employees SET
       name = COALESCE($2, name),
       phone = COALESCE($3, phone),
       role = COALESCE($4, role),
       active = COALESCE($5, active),
       pin_hash = COALESCE($6, pin_hash)
     WHERE id = $1 RETURNING *`,
    [id, patch.name ?? null, patch.phone ?? null, patch.role ?? null, patch.active ?? null, patch.pinHash ?? null]
  );
  return rows[0] ? toEmployee(rows[0]) : null;
}

// ── Attendance ───────────────────────────────────────────────────────────────

function fix(lat: any, lng: any, acc: any, dist: any): AttendanceFix {
  return {
    lat: Number(lat),
    lng: Number(lng),
    accuracyM: Number(acc),
    distanceM: dist == null ? null : Number(dist),
  };
}

function toAttendance(r: any): AttendanceEntry {
  return {
    id: r.id,
    employeeId: r.employee_id,
    employeeName: r.employee_name ?? "",
    workDate: r.work_date,
    checkinAt: Number(r.checkin_at),
    checkin: fix(r.checkin_lat, r.checkin_lng, r.checkin_accuracy_m, r.checkin_distance_m),
    checkoutAt: r.checkout_at == null ? null : Number(r.checkout_at),
    checkout:
      r.checkout_at == null
        ? null
        : fix(r.checkout_lat, r.checkout_lng, r.checkout_accuracy_m, r.checkout_distance_m),
  };
}

const ATTENDANCE_SELECT = `
  SELECT a.*, e.name AS employee_name FROM attendance a
  JOIN employees e ON e.id = a.employee_id
`;

export async function getAttendance(
  employeeId: string,
  workDate: string
): Promise<AttendanceEntry | null> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `${ATTENDANCE_SELECT} WHERE a.employee_id = $1 AND a.work_date = $2`,
    [employeeId, workDate]
  );
  return rows[0] ? toAttendance(rows[0]) : null;
}

/** Attendance rejected for a reason the employee should see. */
export class AttendanceError extends Error {
  constructor(readonly code: "already_in" | "not_in" | "already_out", message: string) {
    super(message);
    this.name = "AttendanceError";
  }
}

export async function checkIn(input: {
  employeeId: string;
  workDate: string;
  at: number;
  fix: AttendanceFix;
}): Promise<AttendanceEntry> {
  await ensureSchema();
  // ON CONFLICT DO NOTHING makes the day's unique index the arbiter, so two
  // taps in the same instant can't produce two rows.
  const { rows } = await getPool().query(
    `INSERT INTO attendance (
       id, employee_id, work_date, checkin_at,
       checkin_lat, checkin_lng, checkin_accuracy_m, checkin_distance_m
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (employee_id, work_date) DO NOTHING
     RETURNING *`,
    [
      randomUUID(), input.employeeId, input.workDate, input.at,
      input.fix.lat, input.fix.lng, input.fix.accuracyM, input.fix.distanceM,
    ]
  );
  if (!rows[0]) throw new AttendanceError("already_in", "You've already checked in today");
  const entry = await getAttendance(input.employeeId, input.workDate);
  return entry ?? toAttendance(rows[0]);
}

export async function checkOut(input: {
  employeeId: string;
  workDate: string;
  at: number;
  fix: AttendanceFix;
}): Promise<AttendanceEntry> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `UPDATE attendance SET
       checkout_at = $3, checkout_lat = $4, checkout_lng = $5,
       checkout_accuracy_m = $6, checkout_distance_m = $7
     WHERE employee_id = $1 AND work_date = $2 AND checkout_at IS NULL
     RETURNING *`,
    [
      input.employeeId, input.workDate, input.at,
      input.fix.lat, input.fix.lng, input.fix.accuracyM, input.fix.distanceM,
    ]
  );
  if (!rows[0]) {
    const existing = await getAttendance(input.employeeId, input.workDate);
    throw existing
      ? new AttendanceError("already_out", "You've already checked out today")
      : new AttendanceError("not_in", "Check in first");
  }
  const entry = await getAttendance(input.employeeId, input.workDate);
  return entry ?? toAttendance(rows[0]);
}

export async function listAttendanceForDay(workDate: string): Promise<AttendanceEntry[]> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `${ATTENDANCE_SELECT} WHERE a.work_date = $1 ORDER BY a.checkin_at`,
    [workDate]
  );
  return rows.map(toAttendance);
}

export async function listAttendanceBetween(
  fromDate: string,
  toDate: string
): Promise<AttendanceEntry[]> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `${ATTENDANCE_SELECT} WHERE a.work_date BETWEEN $1 AND $2
     ORDER BY a.work_date DESC, a.checkin_at`,
    [fromDate, toDate]
  );
  return rows.map(toAttendance);
}

/** The roster joined to one day's attendance and approved leave. */
export async function attendanceForDay(workDate: string): Promise<AttendanceRow[]> {
  const [employees, entries, leaves] = await Promise.all([
    listEmployees(),
    listAttendanceForDay(workDate),
    listLeavesCovering(workDate),
  ]);
  const byEmployee = new Map(entries.map((e) => [e.employeeId, e]));
  const leaveBy = new Map(leaves.filter((l) => l.status === "approved").map((l) => [l.employeeId, l]));
  return employees.map((employee) => ({
    employee,
    entry: byEmployee.get(employee.id) ?? null,
    onLeave: leaveBy.get(employee.id) ?? null,
  }));
}

// ── Leave ────────────────────────────────────────────────────────────────────

/** Inclusive day count across an IST date range. */
export function countDays(fromDate: string, toDate: string): number {
  const a = Date.parse(`${fromDate}T00:00:00Z`);
  const b = Date.parse(`${toDate}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
  return Math.round((b - a) / 86_400_000) + 1;
}

function toLeave(r: any): LeaveRequest {
  return {
    id: r.id,
    employeeId: r.employee_id,
    employeeName: r.employee_name ?? "",
    fromDate: r.from_date,
    toDate: r.to_date,
    days: countDays(r.from_date, r.to_date),
    leaveType: r.leave_type as LeaveType,
    reason: r.reason,
    status: r.status as LeaveStatus,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at == null ? null : Number(r.decided_at),
    decisionNote: r.decision_note,
    createdAt: Number(r.created_at),
  };
}

const LEAVE_SELECT = `
  SELECT l.*, e.name AS employee_name FROM leave_requests l
  JOIN employees e ON e.id = l.employee_id
`;

export async function createLeave(input: {
  employeeId: string;
  fromDate: string;
  toDate: string;
  leaveType: LeaveType;
  reason: string;
}): Promise<LeaveRequest> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `WITH inserted AS (
       INSERT INTO leave_requests (
         id, employee_id, from_date, to_date, leave_type, reason, status, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,'pending',$7) RETURNING *
     )
     SELECT inserted.*, e.name AS employee_name FROM inserted
     JOIN employees e ON e.id = inserted.employee_id`,
    [
      randomUUID(), input.employeeId, input.fromDate, input.toDate,
      input.leaveType, input.reason, Date.now(),
    ]
  );
  return toLeave(rows[0]);
}

export async function listLeaves(opts?: {
  employeeId?: string;
  status?: LeaveStatus;
}): Promise<LeaveRequest[]> {
  await ensureSchema();
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts?.employeeId) {
    params.push(opts.employeeId);
    where.push(`l.employee_id = $${params.length}`);
  }
  if (opts?.status) {
    params.push(opts.status);
    where.push(`l.status = $${params.length}`);
  }
  const { rows } = await getPool().query(
    `${LEAVE_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY l.from_date DESC, l.created_at DESC`,
    params
  );
  return rows.map(toLeave);
}

/** Leave requests whose range covers a given IST day, any status. */
export async function listLeavesCovering(day: string): Promise<LeaveRequest[]> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `${LEAVE_SELECT} WHERE $1 BETWEEN l.from_date AND l.to_date`,
    [day]
  );
  return rows.map(toLeave);
}

export async function decideLeave(
  id: string,
  status: Exclude<LeaveStatus, "pending">,
  decidedBy: string,
  note: string
): Promise<LeaveRequest | null> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `WITH updated AS (
       UPDATE leave_requests
       SET status = $2, decided_by = $3, decided_at = $4, decision_note = $5
       WHERE id = $1 RETURNING *
     )
     SELECT updated.*, e.name AS employee_name FROM updated
     JOIN employees e ON e.id = updated.employee_id`,
    [id, status, decidedBy, Date.now(), note]
  );
  return rows[0] ? toLeave(rows[0]) : null;
}

// ── Maintenance issues ───────────────────────────────────────────────────────

function toIssue(r: any): MaintenanceIssue {
  return {
    id: r.id,
    kind: r.kind as IssueKind,
    title: r.title,
    details: r.details,
    priority: r.priority as IssuePriority,
    status: r.status as IssueStatus,
    photoUrl: r.photo_url,
    reportedByName: r.reported_by_name,
    createdAt: Number(r.created_at),
    resolvedAt: r.resolved_at == null ? null : Number(r.resolved_at),
    resolutionNote: r.resolution_note,
  };
}

export async function createIssue(input: {
  kind: IssueKind;
  title: string;
  details: string;
  priority: IssuePriority;
  photoUrl: string;
  reportedByName: string;
}): Promise<MaintenanceIssue> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `INSERT INTO maintenance_issues (
       id, kind, title, details, priority, status, photo_url, reported_by_name, created_at
     ) VALUES ($1,$2,$3,$4,$5,'open',$6,$7,$8) RETURNING *`,
    [
      randomUUID(), input.kind, input.title, input.details, input.priority,
      input.photoUrl, input.reportedByName, Date.now(),
    ]
  );
  return toIssue(rows[0]);
}

export async function listIssues(status?: IssueStatus): Promise<MaintenanceIssue[]> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT * FROM maintenance_issues ${status ? "WHERE status = $1" : ""}
     ORDER BY
       CASE status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
       CASE priority WHEN 'urgent' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
       created_at DESC`,
    status ? [status] : []
  );
  return rows.map(toIssue);
}

export async function updateIssueStatus(
  id: string,
  status: IssueStatus,
  note: string
): Promise<MaintenanceIssue | null> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `UPDATE maintenance_issues
     SET status = $2,
         resolved_at = CASE WHEN $2 = 'resolved' THEN $3 ELSE NULL END,
         resolution_note = $4
     WHERE id = $1 RETURNING *`,
    [id, status, Date.now(), note]
  );
  return rows[0] ? toIssue(rows[0]) : null;
}

// ── Feedback ─────────────────────────────────────────────────────────────────

function toFeedback(r: any): Feedback {
  return {
    id: r.id,
    rating: r.rating,
    improve: r.improve,
    name: r.name,
    phone: r.phone,
    sentToGoogle: r.sent_to_google,
    createdAt: Number(r.created_at),
  };
}

export async function createFeedback(input: {
  rating: number;
  improve: string;
  name: string;
  phone: string;
  sentToGoogle: boolean;
}): Promise<Feedback> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `INSERT INTO feedback (id, rating, improve, name, phone, sent_to_google, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [
      randomUUID(), input.rating, input.improve, input.name,
      input.phone, input.sentToGoogle, Date.now(),
    ]
  );
  return toFeedback(rows[0]);
}

/** Fill in what a rater added after the fact (the improve note, or the Google hand-off). */
export async function updateFeedback(
  id: string,
  patch: { improve?: string; name?: string; phone?: string; sentToGoogle?: boolean }
): Promise<Feedback | null> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `UPDATE feedback SET
       improve = COALESCE($2, improve),
       name = COALESCE($3, name),
       phone = COALESCE($4, phone),
       sent_to_google = COALESCE($5, sent_to_google)
     WHERE id = $1 RETURNING *`,
    [id, patch.improve ?? null, patch.name ?? null, patch.phone ?? null, patch.sentToGoogle ?? null]
  );
  return rows[0] ? toFeedback(rows[0]) : null;
}

export async function listFeedback(limit = 200): Promise<Feedback[]> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT * FROM feedback ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return rows.map(toFeedback);
}

/* eslint-enable @typescript-eslint/no-explicit-any */
