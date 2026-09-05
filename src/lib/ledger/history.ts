/**
 * Turning an audit row's before/after into a line a person can read.
 *
 * Done on the server, once, rather than shipping raw JSON to the browser and
 * making the board diff it. The history is meant to be skimmed — "Cash ₹3,000
 * → ₹4,500" answers the question; two JSON blobs make the reader do the work.
 */

import type { EditAction, EditEntity } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */

const inr = (n: unknown) => `₹${Math.round(Number(n ?? 0)).toLocaleString("en-IN")}`;

/** "taken out" / "put in" — how a movement reads in a sentence. */
const moved = (row: any) => (row?.direction === "out" ? "taken out" : "put in");

/** Trailing "· Owner · Bank deposit" for a movement, skipping what's blank. */
function movementContext(row: any): string {
  const parts = [row?.party, row?.reason].filter((p) => typeof p === "string" && p.trim());
  return parts.length ? ` · ${parts.join(" · ")}` : "";
}

function declarationChanges(before: any, after: any): string[] {
  const out: string[] = [];
  if (Number(before.cashInr) !== Number(after.cashInr)) {
    out.push(`Cash ${inr(before.cashInr)} → ${inr(after.cashInr)}`);
  }
  if (Number(before.onlineInr) !== Number(after.onlineInr)) {
    out.push(`Online ${inr(before.onlineInr)} → ${inr(after.onlineInr)}`);
  }
  if ((before.note ?? "") !== (after.note ?? "")) {
    // The note itself can be long; say that it moved, not what it now says.
    out.push(after.note ? (before.note ? "Note changed" : "Note added") : "Note removed");
  }
  if ((before.enteredBy ?? "") !== (after.enteredBy ?? "")) {
    out.push(`Counted by ${after.enteredBy || "—"}`);
  }
  return out;
}

export function describeEdit(
  entity: EditEntity,
  action: EditAction,
  before: any,
  after: any
): string {
  if (entity === "declaration") {
    if (action === "created") {
      return `Declared ${inr(after.cashInr)} cash · ${inr(after.onlineInr)} online`;
    }
    const changes = declarationChanges(before ?? {}, after ?? {});
    // An update that changed nothing isn't recorded, but be safe rather than
    // rendering an empty line if one ever slips through.
    return changes.length ? changes.join(" · ") : "Re-saved with no change";
  }

  if (entity === "movement") {
    if (action === "deleted") {
      return `Removed ${inr(before?.amountInr)} ${moved(before)}${movementContext(before)}`;
    }
    const row = after ?? {};
    return `${inr(row.amountInr)} ${moved(row)}${movementContext(row)}`;
  }

  // Opening balance.
  if (action === "created") return `Opening balance set to ${inr(after?.openingInr)}`;
  const parts: string[] = [];
  if (Number(before?.openingInr) !== Number(after?.openingInr)) {
    parts.push(`Opening ${inr(before?.openingInr)} → ${inr(after?.openingInr)}`);
  }
  if ((before?.startsOn ?? null) !== (after?.startsOn ?? null)) {
    parts.push(`Ledger starts ${after?.startsOn ?? "on the 1st"}`);
  }
  return parts.length ? parts.join(" · ") : `Opening balance set to ${inr(after?.openingInr)}`;
}

/* eslint-enable @typescript-eslint/no-explicit-any */
