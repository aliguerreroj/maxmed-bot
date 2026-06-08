/**
 * Deterministic price-lookup engine.
 *
 * Pure function: same (request, data, today) → same result, every time.
 * No DB, no network, no Date.now(). The bot handler pre-fetches data from
 * Prisma and injects `today`; tests construct data directly.
 *
 * Grounding invariant: every "found" result is traceable to a specific
 * BasePrice row (and optionally an AdjustmentRule). The engine never
 * invents a number — it either finds one in the data or returns a
 * non-"found" status that routes to a human.
 */

import type {
  PriceLookupRequest,
  PriceLookupResult,
  PriceRow,
  DingRule,
} from "./types.js";

/** Maximum months since expiration for expired items. */
const EXPIRED_MAX_MONTHS = 6;

/**
 * Look up a price.
 *
 * @param request     - What the seller has (product, condition, expiration).
 * @param productRows - All BasePrice rows for this (category, productName, reference).
 *                      The caller pre-filters; the engine does condition/date matching.
 * @param rules       - All adjustment rules, keyed by scopeKey.
 * @param today       - Current date (injected for deterministic testing).
 */
export function lookupPrice(
  request: PriceLookupRequest,
  productRows: PriceRow[],
  rules: Map<string, DingRule>,
  today: Date = new Date(),
): PriceLookupResult {
  // ---- no rows at all → not found (route to human) ----
  if (productRows.length === 0) {
    return {
      status: "not_found",
      reason:
        `"${request.productName}"` +
        (request.reference ? ` (ref: ${request.reference})` : "") +
        ` not found in ${request.category}.`,
    };
  }

  switch (request.condition) {
    case "mint":
      return lookupMint(request, productRows);
    case "ding":
      return lookupDing(request, productRows, rules);
    case "expired":
      return lookupExpired(request, productRows, today);
    case "damaged":
    case "short_date":
      return lookupFlat(request, productRows);
  }
}

// ---- condition-specific handlers ----

function lookupMint(
  request: PriceLookupRequest,
  rows: PriceRow[],
): PriceLookupResult {
  const mintRows = rows.filter((r) => r.condition === "mint");
  if (mintRows.length === 0) {
    return {
      status: "not_purchased",
      reason: `"${request.productName}" is not purchased in mint condition.`,
    };
  }

  // Non-expiring items have null dateFrom — match without a date.
  const nonExpiring = mintRows.filter((r) => r.dateFrom === null);
  if (nonExpiring.length > 0) {
    const row = nonExpiring[0]!;
    return {
      status: "found",
      finalPrice: row.price,
      breakdown: `Mint price: $${row.price} (non-expiring item)`,
      basePriceId: row.id,
    };
  }

  // Expiring items: need a date to match against tiers.
  if (!request.expirationDate) {
    return {
      status: "not_purchased",
      reason:
        `Expiration date is required for "${request.productName}" but was not provided.`,
    };
  }

  const tier = matchDateTier(mintRows, request.expirationDate);
  if (!tier) {
    return {
      status: "not_purchased",
      reason:
        `"${request.productName}" is not purchased with expiration ` +
        `${fmtDate(request.expirationDate)}.`,
    };
  }

  return {
    status: "found",
    finalPrice: tier.price,
    breakdown:
      `Mint price: $${tier.price} (expiration ${fmtDate(request.expirationDate)})`,
    basePriceId: tier.id,
  };
}

function lookupDing(
  request: PriceLookupRequest,
  rows: PriceRow[],
  rules: Map<string, DingRule>,
): PriceLookupResult {
  // Ding = mint tier price + negative delta. Find the mint tier first.
  const mintResult = lookupMint(request, rows);
  if (mintResult.status !== "found") {
    // Propagate the failure — can't ding without a base mint price.
    return mintResult;
  }

  // Find the ding rule linked to this mint row.
  const mintRow = rows.find((r) => r.id === mintResult.basePriceId);
  if (!mintRow?.dingRuleKey) {
    return {
      status: "not_purchased",
      reason: `"${request.productName}" does not have a ding adjustment available.`,
    };
  }

  const rule = rules.get(mintRow.dingRuleKey);
  if (!rule) {
    // This would be a data integrity issue — the parser linked a scopeKey
    // that doesn't exist. Fail loud.
    throw new Error(
      `GROUNDING VIOLATION: ding rule "${mintRow.dingRuleKey}" referenced by ` +
        `BasePrice id=${mintRow.id} but not found in rules map.`,
    );
  }

  const finalPrice = mintResult.finalPrice + rule.deltaAmount;

  return {
    status: "found",
    finalPrice,
    breakdown:
      `Ding price: $${mintResult.finalPrice} mint ` +
      `− $${Math.abs(rule.deltaAmount)} ding adjustment = $${finalPrice}`,
    basePriceId: mintResult.basePriceId,
    adjustmentRuleId: rule.id,
  };
}

function lookupExpired(
  request: PriceLookupRequest,
  rows: PriceRow[],
  today: Date,
): PriceLookupResult {
  const expiredRows = rows.filter((r) => r.condition === "expired");
  if (expiredRows.length === 0) {
    return {
      status: "not_purchased",
      reason: `"${request.productName}" is not purchased in expired condition.`,
    };
  }

  if (!request.expirationDate) {
    return {
      status: "not_purchased",
      reason:
        `Expiration date is required for expired items but was not provided.`,
    };
  }

  // Gate 1: the item must actually be expired (expiration in the past).
  if (request.expirationDate >= today) {
    return {
      status: "not_purchased",
      reason:
        `Item has not expired yet (expiration ${fmtDate(request.expirationDate)} ` +
        `is in the future). Use mint condition instead.`,
    };
  }

  // Gate 2: expired within the acceptance window.
  if (!isWithinMonths(request.expirationDate, today, EXPIRED_MAX_MONTHS)) {
    const months = approxMonthsAgo(request.expirationDate, today);
    return {
      status: "expired_too_old",
      reason:
        `Item expired ~${months} months ago, exceeding the ` +
        `${EXPIRED_MAX_MONTHS}-month maximum.`,
    };
  }

  const row = expiredRows[0]!;
  const months = approxMonthsAgo(request.expirationDate, today);

  return {
    status: "found",
    finalPrice: row.price,
    breakdown:
      `Expired price: $${row.price} ` +
      `(expired ~${months} month${months === 1 ? "" : "s"} ago, ` +
      `within ${EXPIRED_MAX_MONTHS}-month window)`,
    basePriceId: row.id,
  };
}

function lookupFlat(
  request: PriceLookupRequest,
  rows: PriceRow[],
): PriceLookupResult {
  const matching = rows.filter((r) => r.condition === request.condition);
  if (matching.length === 0) {
    return {
      status: "not_purchased",
      reason:
        `"${request.productName}" is not purchased in ` +
        `${request.condition.replace("_", " ")} condition.`,
    };
  }

  const row = matching[0]!;
  const label =
    request.condition === "short_date" ? "Short date" : "Damaged";

  return {
    status: "found",
    finalPrice: row.price,
    breakdown: `${label} price: $${row.price}`,
    basePriceId: row.id,
  };
}

// ---- date helpers ----

/**
 * Match an expiration date against date tiers.
 * Sorted newest→oldest (dateFrom DESC); first match wins.
 * A tier matches when: dateFrom <= expDate AND (dateTo is null OR expDate <= dateTo).
 */
function matchDateTier(
  mintRows: PriceRow[],
  expDate: Date,
): PriceRow | null {
  const sorted = mintRows
    .filter((r) => r.dateFrom !== null)
    .sort((a, b) => b.dateFrom!.getTime() - a.dateFrom!.getTime());

  for (const row of sorted) {
    if (expDate >= row.dateFrom!) {
      if (row.dateTo === null || expDate <= row.dateTo) {
        return row;
      }
    }
  }
  return null;
}

/**
 * True if expDate is within `maxMonths` months before `today`.
 * Day-precise: computes the exact cutoff date by rolling back months.
 */
function isWithinMonths(
  expDate: Date,
  today: Date,
  maxMonths: number,
): boolean {
  const cutoff = new Date(today);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - maxMonths);
  return expDate >= cutoff;
}

/** Approximate months between two dates (for human-readable display only). */
function approxMonthsAgo(earlier: Date, later: Date): number {
  return (
    (later.getUTCFullYear() - earlier.getUTCFullYear()) * 12 +
    (later.getUTCMonth() - earlier.getUTCMonth())
  );
}

/** Format a date as M/YYYY for breakdown strings. */
function fmtDate(d: Date): string {
  return `${d.getUTCMonth() + 1}/${d.getUTCFullYear()}`;
}
