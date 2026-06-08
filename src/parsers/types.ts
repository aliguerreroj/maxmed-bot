/**
 * Intermediate representation for parsed price data.
 * Independent of Prisma — the loader maps these to DB rows.
 * All prices are string-encoded decimals to avoid float corruption.
 */

/** The set of known conditions. The price engine validates against this at
 *  runtime and throws on anything unexpected (fail-loud, per spec). */
export const KNOWN_CONDITIONS = ["mint", "damaged", "short_date", "expired"] as const;
export type Condition = (typeof KNOWN_CONDITIONS)[number];

export interface DateRange {
  from: Date | null; // inclusive lower bound (UTC date, no time)
  to: Date | null; // inclusive upper bound; null = open-ended "+" tier
}

export interface ParsedBasePrice {
  category: string;
  productName: string;
  reference: string | null;
  condition: Condition;
  dateFrom: Date | null;
  dateTo: Date | null;
  price: string; // decimal as string, e.g. "60" — Prisma Decimal accepts this
  dingRuleKey: string | null; // links mint rows to their ding rule
  sourceSheet: string;
  sourceRow: number;
}

export interface ParsedAdjustmentRule {
  scopeKey: string; // e.g. "test_strips:ding:3"
  deltaAmount: string; // negative decimal string, e.g. "-3"
  note: string | null; // verbatim rule text from the sheet
  sourceSheet: string;
}

export interface ParseResult {
  prices: ParsedBasePrice[];
  rules: ParsedAdjustmentRule[];
  warnings: string[];
}

/** Column classification produced by header analysis. */
export type ColumnRole =
  | { role: "product" }
  | { role: "reference" }
  | { role: "mintTier"; range: DateRange }
  | { role: "expired" }
  | { role: "damaged" }
  | { role: "shortDate" }
  | { role: "ding" }
  | { role: "ignore" };
