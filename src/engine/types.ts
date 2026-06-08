/**
 * Types for the price-lookup engine.
 *
 * The engine is a pure function: (request, data, today) → result.
 * No DB dependency, no side effects, fully deterministic when `today` is fixed.
 */

/** Accepted request conditions. "ding" is a computed condition (not stored). */
export type RequestCondition =
  | "mint"
  | "ding"
  | "damaged"
  | "short_date"
  | "expired";

/** What the extraction step (Phase 4) hands to the engine. */
export interface PriceLookupRequest {
  category: string;
  productName: string;
  reference: string | null;
  condition: RequestCondition;
  expirationDate: Date | null; // seller's reported expiration; null for non-expiring items
}

// ---- data rows the engine operates on (mirrors DB but decoupled from Prisma) ----

export interface PriceRow {
  id: number;
  category: string;
  productName: string;
  reference: string | null;
  condition: string; // stored condition: mint | damaged | short_date | expired
  dateFrom: Date | null;
  dateTo: Date | null;
  price: number;
  dingRuleKey: string | null;
}

export interface DingRule {
  id: number;
  scopeKey: string;
  deltaAmount: number; // negative, e.g. -3
}

// ---- result types — discriminated union, every "found" carries provenance ----

export type PriceLookupResult =
  | PriceFound
  | PriceNotPurchased
  | PriceNotFound
  | PriceExpiredTooOld;

/** A grounded price was computed. Traceable to exact DB rows. */
export interface PriceFound {
  status: "found";
  finalPrice: number;
  /** Human-readable breakdown for the phrasing LLM. */
  breakdown: string;
  /** The BasePrice row that produced (or anchored) this price. */
  basePriceId: number;
  /** Set only for ding — the AdjustmentRule that was applied. */
  adjustmentRuleId?: number;
}

/** Product exists in the DB but not purchasable in this condition/date. */
export interface PriceNotPurchased {
  status: "not_purchased";
  reason: string;
}

/** Product not in the DB at all — route to a human. */
export interface PriceNotFound {
  status: "not_found";
  reason: string;
}

/** Expired item is too old (exceeds the 6-month window). */
export interface PriceExpiredTooOld {
  status: "expired_too_old";
  reason: string;
}
