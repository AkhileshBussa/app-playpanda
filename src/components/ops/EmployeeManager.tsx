"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { Employee, EmployeeRole } from "@/lib/staff/types";

/**
 * Roster management. Employees are never deleted — attendance and leave rows
 * point at them and the history is the whole point — so "remove" deactivates,
 * which takes them off the /staff check-in picker and keeps the record.
 */
export default function EmployeeManager() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Employee | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/ops/employees");
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Couldn't load");
      setEmployees(body.employees);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function patch(id: string, body: Record<string, unknown>) {
    await fetch("/api/ops/employees", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...body }),
    });
    load();
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-3 pb-20">
      <div className="mt-3 flex items-center justify-between gap-3">
        <Link
          href="/ops/attendance"
          className="rounded-full bg-white px-3.5 py-2 text-sm font-black text-ink/60 hover:bg-ink/10"
        >
          ← Attendance
        </Link>
        <button
          onClick={() => setAdding(true)}
          className="rounded-full bg-coral px-4 py-2 text-sm font-black text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed"
        >
          + Add employee
        </button>
      </div>

      {loading ? (
        <div className="py-24 text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-ink/15 border-t-coral" />
        </div>
      ) : error ? (
        <p className="py-24 text-center text-base font-bold text-coral">{error}</p>
      ) : employees.length === 0 ? (
        <p className="py-16 text-center text-base font-bold text-ink/40">
          No employees yet. Add the team so they can mark attendance at /staff.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {employees.map((e) => (
            <li
              key={e.id}
              className={`rounded-2xl bg-white p-3.5 shadow-chunk ${e.active ? "" : "opacity-60"}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-lg font-black text-ink">
                    {e.name}
                    {e.role === "manager" && (
                      <span className="ml-1.5 rounded-full bg-ink/10 px-2 py-0.5 text-[11px] font-black uppercase tracking-wide text-ink/50">
                        Manager
                      </span>
                    )}
                    {!e.active && (
                      <span className="ml-1.5 rounded-full bg-ink/10 px-2 py-0.5 text-[11px] font-black uppercase tracking-wide text-ink/50">
                        Inactive
                      </span>
                    )}
                  </p>
                  <p className="text-sm font-bold text-ink/50">{e.phone || "No phone"}</p>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <button
                    onClick={() => setEditing(e)}
                    className="rounded-full bg-cream px-3 py-1.5 text-xs font-black text-ink/60 hover:bg-ink/10"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => patch(e.id, { active: !e.active })}
                    className="rounded-full bg-cream px-3 py-1.5 text-xs font-black text-ink/60 hover:bg-ink/10"
                  >
                    {e.active ? "Deactivate" : "Restore"}
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {(adding || editing) && (
        <EmployeeSheet
          employee={editing}
          onClose={() => {
            setAdding(false);
            setEditing(null);
          }}
          onSaved={() => {
            setAdding(false);
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function EmployeeSheet({
  employee,
  onClose,
  onSaved,
}: {
  employee: Employee | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(employee?.name ?? "");
  const [phone, setPhone] = useState(employee?.phone ?? "");
  const [role, setRole] = useState<EmployeeRole>(employee?.role ?? "staff");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/ops/employees", {
        method: employee ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          employee
            ? { id: employee.id, name, phone, role, ...(pin ? { pin } : {}) }
            : { name, phone, role, pin }
        ),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error || "Couldn't save");
        return;
      }
      onSaved();
    } catch {
      setError("Network error — please retry");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-ink/40" onClick={busy ? undefined : onClose} />
      <form
        onSubmit={submit}
        className="relative w-full max-w-md rounded-t-chunk bg-cream p-5 sm:rounded-chunk"
      >
        <h2 className="text-xl font-black text-ink">
          {employee ? `Edit ${employee.name}` : "Add employee"}
        </h2>

        <label className="mt-3 block">
          <span className="mb-1.5 block px-1 text-sm font-black text-ink/60">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus={!employee}
            className="w-full rounded-2xl border-2 border-ink/10 bg-white px-4 py-3 text-base font-bold text-ink outline-none focus:border-coral"
          />
        </label>

        <label className="mt-3 block">
          <span className="mb-1.5 block px-1 text-sm font-black text-ink/60">Phone</span>
          <input
            inputMode="numeric"
            maxLength={10}
            value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))}
            placeholder="Optional"
            className="w-full rounded-2xl border-2 border-ink/10 bg-white px-4 py-3 text-base font-bold text-ink outline-none placeholder:text-ink/30 focus:border-coral"
          />
        </label>

        <div className="mt-3">
          <span className="mb-1.5 block px-1 text-sm font-black text-ink/60">Role</span>
          <div className="flex gap-1.5">
            {(["staff", "manager"] as const).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRole(r)}
                className={`flex-1 rounded-full px-3.5 py-2 text-sm font-black capitalize transition-colors ${
                  role === r ? "bg-ink text-cream" : "bg-white text-ink/60 hover:bg-ink/10"
                }`}
              >
                {r}
              </button>
            ))}
          </div>
          <p className="mt-1 px-1 text-xs font-bold text-ink/40">
            Role is a label on the roster — approving leave still needs the ops password.
          </p>
        </div>

        <label className="mt-3 block">
          <span className="mb-1.5 block px-1 text-sm font-black text-ink/60">
            {employee ? "New PIN (leave blank to keep)" : "4-digit PIN"}
          </span>
          <input
            inputMode="numeric"
            maxLength={4}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
            className="w-full rounded-2xl border-2 border-ink/10 bg-white px-4 py-3 text-center font-mono text-xl font-black tracking-[0.4em] text-ink outline-none focus:border-coral"
          />
        </label>

        {error && <p className="mt-2 px-1 text-sm font-bold text-coral">{error}</p>}

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-full bg-white py-3 text-base font-black text-ink/60 hover:bg-ink/10"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !name.trim() || (!employee && pin.length !== 4)}
            className="flex-1 rounded-full bg-ink py-3 text-base font-black text-cream shadow-btn transition-all active:translate-y-0.5 active:shadow-btn-pressed disabled:opacity-40"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}
