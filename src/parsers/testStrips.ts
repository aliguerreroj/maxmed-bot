import type { Worksheet } from "exceljs";
import { classifyColumn } from "./dates.js";
import { cellText, cellPrice, isNA, parseDingDelta, findHeaderRows } from "./helpers.js";
import type {
  ParseResult,
  ParsedBasePrice,
  ParsedAdjustmentRule,
  ColumnRole,
  Condition,
} from "./types.js";

const CATEGORY = "test_strips";
const SHEET_NAME = "Test Strips";

/**
 * Parse the "Test Strips" sheet. Handles multiple header blocks (rows 1 and 29
 * in the current data, each with different date tiers).
 */
export function parseTestStrips(ws: Worksheet): ParseResult {
  const prices: ParsedBasePrice[] = [];
  const rules: ParsedAdjustmentRule[] = [];
  const warnings: string[] = [];

  // --- Track ding rules by scopeKey to dedup across blocks ---
  const rulesByScopeKey = new Map<string, ParsedAdjustmentRule>();

  const headerRows = findHeaderRows(ws);
  if (headerRows.length === 0) {
    warnings.push("No header rows found in Test Strips sheet");
    return { prices, rules, warnings };
  }

  const maxRow = ws.rowCount;
  const maxCol = ws.columnCount;

  for (let hi = 0; hi < headerRows.length; hi++) {
    const headerRow = headerRows[hi]!;
    const nextHeaderRow = headerRows[hi + 1] ?? maxRow + 1;

    // ---- classify every column in this header ----
    const columnMap: Array<{ col: number; role: ColumnRole }> = [];
    let productCol: number | null = null;
    let dingCol: number | null = null;

    for (let c = 1; c <= maxCol; c++) {
      const label = cellText(ws, headerRow, c);
      const role = classifyColumn(label);
      columnMap.push({ col: c, role });

      if (role.role === "product") productCol = c;
      if (role.role === "ding") dingCol = c;
    }

    if (productCol === null) {
      warnings.push(`Header at row ${headerRow}: no product column found`);
      continue;
    }

    // ---- extract ding rule for this block ----
    let blockDingScopeKey: string | null = null;

    if (dingCol !== null) {
      // Read the ding text from the first data row (merge master)
      const firstDataRow = headerRow + 1;
      const dingText = cellText(ws, firstDataRow, dingCol);
      if (dingText) {
        const delta = parseDingDelta(dingText);
        if (delta !== null) {
          const scopeKey = `${CATEGORY}:ding:${Math.abs(delta)}`;
          blockDingScopeKey = scopeKey;

          if (!rulesByScopeKey.has(scopeKey)) {
            rulesByScopeKey.set(scopeKey, {
              scopeKey,
              deltaAmount: String(delta),
              note: dingText,
              sourceSheet: SHEET_NAME,
            });
          }
        } else {
          warnings.push(
            `Row ${firstDataRow}: could not parse ding delta from "${dingText}"`,
          );
        }
      }
    }

    // ---- identify price columns ----
    type PriceCol = {
      col: number;
      condition: Condition;
      dateFrom: Date | null;
      dateTo: Date | null;
    };
    const priceCols: PriceCol[] = [];

    for (const { col, role } of columnMap) {
      if (role.role === "mintTier") {
        priceCols.push({
          col,
          condition: "mint",
          dateFrom: role.range.from,
          dateTo: role.range.to,
        });
      } else if (role.role === "expired") {
        priceCols.push({
          col,
          condition: "expired",
          dateFrom: null,
          dateTo: null,
        });
      } else if (role.role === "damaged") {
        priceCols.push({
          col,
          condition: "damaged",
          dateFrom: null,
          dateTo: null,
        });
      } else if (role.role === "shortDate") {
        priceCols.push({
          col,
          condition: "short_date",
          dateFrom: null,
          dateTo: null,
        });
      }
    }

    if (priceCols.length === 0) {
      warnings.push(`Header at row ${headerRow}: no price columns identified`);
      continue;
    }

    // ---- iterate data rows ----
    for (let r = headerRow + 1; r < nextHeaderRow; r++) {
      const name = cellText(ws, r, productCol);
      if (!name) continue; // blank separator row

      let emittedAny = false;

      for (const pc of priceCols) {
        const priceStr = cellPrice(ws, r, pc.col);
        if (priceStr === null) continue; // N/A or empty → skip

        prices.push({
          category: CATEGORY,
          productName: name,
          reference: null, // Test Strips have no reference column
          condition: pc.condition,
          dateFrom: pc.dateFrom,
          dateTo: pc.dateTo,
          price: priceStr,
          // Link to ding rule only for mint rows
          dingRuleKey: pc.condition === "mint" ? blockDingScopeKey : null,
          sourceSheet: SHEET_NAME,
          sourceRow: r,
        });
        emittedAny = true;
      }

      if (!emittedAny) {
        warnings.push(
          `Row ${r}: "${name}" has no purchasable prices (all N/A). ` +
            `Will be indistinguishable from not-on-sheet without a Product table.`,
        );
      }
    }
  }

  // ---- collect deduped rules ----
  for (const rule of rulesByScopeKey.values()) {
    rules.push(rule);
  }

  // ---- audit notes ----
  warnings.push(
    `[AUDIT] "expired" condition rows (col5) use a flat price with null date range. ` +
      `The 6-month-back acceptance gate must be enforced at lookup time (Phase 3 engine), ` +
      `not stored here. Condition set now includes "expired" — confirm this expansion is OK.`,
  );

  return { prices, rules, warnings };
}
