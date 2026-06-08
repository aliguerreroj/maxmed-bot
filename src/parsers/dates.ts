import type { ColumnRole, DateRange } from "./types.js";

// ---- date construction helpers (always UTC, no time) ----

/** First day of the month, UTC. */
export function monthStart(year: number, month: number): Date {
  return new Date(Date.UTC(year, month - 1, 1));
}

/** Last day of the month, UTC. Month 13 → rolls to next year correctly. */
export function monthEnd(year: number, month: number): Date {
  return new Date(Date.UTC(year, month, 0));
}

// ---- header label patterns ----

const PLUS_RE = /^(\d{1,2})\/(\d{4})\+$/; // "4/2027+"
const RANGE_RE = /^(\d{1,2})\/(\d{4})\s*-\s*(\d{1,2})\/(\d{4})$/; // "3/2027-12/2026"
const SINGLE_RE = /^(\d{1,2})\/(\d{4})$/; // "11/2026"

/**
 * Attempt to parse a header label as a date-tier range.
 * Returns null if the label isn't a recognizable date pattern.
 */
export function parseDateTier(label: string): DateRange | null {
  const t = label.trim();

  // "4/2027+" → from first of that month, open-ended
  let m = t.match(PLUS_RE);
  if (m) {
    const [, mo, yr] = m;
    return { from: monthStart(+yr!, +mo!), to: null };
  }

  // "3/2027-12/2026" → inclusive range, endpoints sorted chronologically
  m = t.match(RANGE_RE);
  if (m) {
    const [, m1, y1, m2, y2] = m;
    const a = { y: +y1!, m: +m1! };
    const b = { y: +y2!, m: +m2! };
    // sort so earlier month is "from"
    const earlier = a.y < b.y || (a.y === b.y && a.m <= b.m) ? a : b;
    const later = earlier === a ? b : a;
    return {
      from: monthStart(earlier.y, earlier.m),
      to: monthEnd(later.y, later.m),
    };
  }

  // "11/2026" → that single month
  m = t.match(SINGLE_RE);
  if (m) {
    const [, mo, yr] = m;
    return {
      from: monthStart(+yr!, +mo!),
      to: monthEnd(+yr!, +mo!),
    };
  }

  return null;
}

/**
 * Classify a column header into its role. Works for all sheets —
 * each sheet's parser calls this per header cell to build its column map.
 */
export function classifyColumn(label: string): ColumnRole {
  const t = label.trim();
  if (!t) return { role: "ignore" };

  const lower = t.toLowerCase();

  // Product / block-identifier columns
  if (
    lower === "product" ||
    lower === "libre" ||
    lower === "g6" ||
    lower === "g7"
  ) {
    return { role: "product" };
  }

  if (lower === "reference") return { role: "reference" };
  if (lower === "ding") return { role: "ding" };

  // Damaged / Acceptable Damage
  if (lower.includes("acceptable damage") || lower === "damaged") {
    return { role: "damaged" };
  }

  // Short Dates (Libre sheet)
  if (lower.includes("short date")) return { role: "shortDate" };

  // The "Expires (Minor Damage ok…)" column — condition, not a date tier.
  // Must come BEFORE the date-tier check because the long text doesn't
  // match a date pattern anyway, but the early exit is clearer.
  if (lower.includes("expire")) return { role: "expired" };

  // Attempt date-tier parse
  const range = parseDateTier(t);
  if (range) return { role: "mintTier", range };

  return { role: "ignore" };
}
