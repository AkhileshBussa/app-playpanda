/**
 * Staff-tools store — employees, attendance, leave, maintenance issues and
 * customer feedback. Tables are defined in ../db/schema.ts with the rest of
 * the database.
 *
 * Expenses are deliberately absent: those live in Swipe (see ./expenses.ts) so
 * the books stay in one place, exactly as when the counter billed them by hand.
 * ("How did you hear about us?" used to live here too — it's a column on
 * customers now; see ../customers/db.ts.)
 */

import { randomUUID } from "node:crypto";
import { getPool } from "../pg";
import { ensureSchema, ms, msOrNull, TS } from "../db/schema";
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

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Employees ────────────────────────────────────────────────────────────────

function toEmployee(r: any): Employee {
  return {
    id: r.id,
    name: r.name,
    phone: r.phone,
    role: r.role as EmployeeRole,
    active: r.active,
    createdAt: ms(r.created_at),
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
    `INSERT INTO employees (id, name, phone, role, pin_hash, active)
     VALUES ($1,$2,$3,$4,$5,TRUE) RETURNING *`,
    [randomUUID(), input.name, input.phone, input.role, input.pinHash]
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
       pin_hash = COALESCE($6, pin_hash),
       last_updated_at = now()
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
    checkinAt: ms(r.checkin_at),
    checkin: fix(r.checkin_lat, r.checkin_lng, r.checkin_accuracy_m, r.checkin_distance_m),
    checkoutAt: msOrNull(r.checkout_at),
    checkout:
      r.checkout_at == null
        ? null
        : fix(r.checkout_lat, r.checkout_lng, r.checkout_accuracy_m, r.checkout_distance_m),
  };
}

const ATTENDANCE_SELECT = `
  SELECT a.*, a.work_date::text AS work_date, e.name AS employee_name FROM attendance a
  JOIN employees e ON e.id = a.employee_id
`;

export async function getAttendance(
  employeeId: string,
  workDate: string
): Promise<AttendanceEntry | null> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `${ATTENDANCE_SELECT} WHERE a.employee_id = $1 AND a.work_date = $2::date`,
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
     ) VALUES ($1,$2,$3::date,${TS("$4")},$5,$6,$7,$8)
     ON CONFLICT (employee_id, work_date) DO NOTHING
     RETURNING id`,
    [
      randomUUID(), input.employeeId, input.workDate, input.at,
      input.fix.lat, input.fix.lng, input.fix.accuracyM, input.fix.distanceM,
    ]
  );
  if (!rows[0]) throw new AttendanceError("already_in", "You've already checked in today");
  const entry = await getAttendance(input.employeeId, input.workDate);
  if (!entry) throw new Error("attendance vanished after insert");
  return entry;
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
       checkout_at = ${TS("$3")}, checkout_lat = $4, checkout_lng = $5,
       checkout_accuracy_m = $6, checkout_distance_m = $7,
       last_updated_at = now()
     WHERE employee_id = $1 AND work_date = $2::date AND checkout_at IS NULL
     RETURNING id`,
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
  if (!entry) throw new Error("attendance vanished after update");
  return entry;
}

export async function listAttendanceForDay(workDate: string): Promise<AttendanceEntry[]> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `${ATTENDANCE_SELECT} WHERE a.work_date = $1::date ORDER BY a.checkin_at`,
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
    `${ATTENDANCE_SELECT} WHERE a.work_date BETWEEN $1::date AND $2::date
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
    decidedAt: msOrNull(r.decided_at),
    decisionNote: r.decision_note,
    createdAt: ms(r.created_at),
  };
}

const LEAVE_SELECT = `
  SELECT l.*, l.from_date::text AS from_date, l.to_date::text AS to_date,
    e.name AS employee_name FROM leave_requests l
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
         id, employee_id, from_date, to_date, leave_type, reason, status
       ) VALUES ($1,$2,$3::date,$4::date,$5,$6,'pending') RETURNING *
     )
     SELECT inserted.*, inserted.from_date::text AS from_date,
       inserted.to_date::text AS to_date, e.name AS employee_name FROM inserted
     JOIN employees e ON e.id = inserted.employee_id`,
    [randomUUID(), input.employeeId, input.fromDate, input.toDate, input.leaveType, input.reason]
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
    `${LEAVE_SELECT} WHERE $1::date BETWEEN l.from_date AND l.to_date`,
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
       SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4,
         last_updated_at = now()
       WHERE id = $1 RETURNING *
     )
     SELECT updated.*, updated.from_date::text AS from_date,
       updated.to_date::text AS to_date, e.name AS employee_name FROM updated
     JOIN employees e ON e.id = updated.employee_id`,
    [id, status, decidedBy, note]
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
    createdAt: ms(r.created_at),
    resolvedAt: msOrNull(r.resolved_at),
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
       id, kind, title, details, priority, status, photo_url, reported_by_name
     ) VALUES ($1,$2,$3,$4,$5,'open',$6,$7) RETURNING *`,
    [randomUUID(), input.kind, input.title, input.details, input.priority, input.photoUrl, input.reportedByName]
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
         resolved_at = CASE WHEN $2 = 'resolved' THEN now() ELSE NULL END,
         resolution_note = $3,
         last_updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, status, note]
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
    createdAt: ms(r.created_at),
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
    `INSERT INTO feedback (id, rating, improve, name, phone, sent_to_google)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [randomUUID(), input.rating, input.improve, input.name, input.phone, input.sentToGoogle]
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
       sent_to_google = COALESCE($5, sent_to_google),
       last_updated_at = now()
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
