/** Wire types for the cash ledger. Amounts are whole-rupee numbers, INR. */

export type MovementDirection = "out" | "in";

/** Cash that moved for a reason that isn't a sale or an expense. */
export interface CashMovement {
  id: string;
  day: string;
  /** "out" = taken from the store (the owner's draw); "in" = float added. */
  direction: MovementDirection;
  amountInr: number;
  reason: string;
  /** Who took it or put it in. */
  party: string;
  recordedBy: string;
  createdAt: number;
}

/** What the counter counted at close of play. */
export interface DayDeclaration {
  day: string;
  cashInr: number;
  onlineInr: number;
  note: string;
  enteredBy: string;
  updatedAt: number;
}

/** Swipe's own collections for a day — the other side of the tally. */
export interface DayTally {
  cash: number;
  /** Card + UPI + everything else Swipe recorded. */
  online: number;
  card: number;
  upi: number;
  other: number;
}

/** Who made a change. The tier is verified; the name is what they typed. */
export interface Actor {
  name: string;
  tier: "counter" | "owner";
}

export type EditEntity = "declaration" | "movement" | "opening";
export type EditAction = "created" | "updated" | "deleted";

/** One entry in the ledger's append-only history. */
export interface LedgerEdit {
  id: string;
  /** When the change was made (not the day it's about). */
  at: number;
  entity: EditEntity;
  action: EditAction;
  /** Self-reported name from the form; empty when nobody picked one. */
  by: string;
  /** From the cookie presented — this one can't be typed in. */
  tier: "counter" | "owner";
  /** Plain-English description, e.g. "Cash ₹3,000 → ₹4,500". */
  summary: string;
}

export interface LedgerDay {
  date: string;
  declared: DayDeclaration | null;
  /**
   * Null for the counter's view (owner-only), and for a day the tally couldn't
   * be fetched for. Never inferred client-side — the server omits it.
   */
  tally: DayTally | null;
  /** Cash spent out of the drawer that day (Swipe expenses paid in Cash). */
  cashSpentInr: number;
  movements: CashMovement[];
  /** Cash in the store at the end of this day. */
  closingInr: number;
  /** Everything ever done to this day, newest first. Empty for an untouched day. */
  edits: LedgerEdit[];
}

export interface LedgerMonth {
  month: string;
  label: string;
  /** Cash in the store when the month began. */
  openingInr: number;
  /** True when a human set it; false when carried from last month's close. */
  openingIsExplicit: boolean;
  openingSetBy: string;
  /** First day the ledger covers this month — the 1st, unless it started mid-month. */
  startsOn: string;
  /** Newest day first, which is the one being worked on. */
  days: LedgerDay[];
  /** Days up to today with nothing declared — the balance is short by these. */
  missingDays: string[];
  totals: {
    declaredCash: number;
    declaredOnline: number;
    /** Null when the tally isn't in this response (counter view, or Swipe down). */
    tallyCash: number | null;
    tallyOnline: number | null;
    cashSpent: number;
    cashTakenOut: number;
    cashPutIn: number;
  };
  /** The number the owner actually wants: cash in the store right now. */
  cashInStoreInr: number;
  /** Changes to this month's opening balance, newest first. */
  openingEdits: LedgerEdit[];
  /** Set when the owner's tally columns couldn't be fetched from Swipe. */
  tallyError: string | null;
  /** Set when cash expenses couldn't be fetched — the balance is then pre-expenses. */
  expensesError: string | null;
}
