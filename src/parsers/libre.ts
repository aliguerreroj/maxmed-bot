import type { Worksheet } from "exceljs";
import { classifyColumn } from "./dates.js";
import {
  cellText,
  cellPrice,
  parseDingDelta,
  findHeaderRows,
} from "./helpers.js";
import type {
  ParseResult,
  ParsedBasePrice,
  ParsedAdjustmentRule,
  ColumnRole,
  DateRange,
} from "./types.js";

const CATEGORY = "libre";
const SHEET_NAME = "Libres";

/** Detect the "readers don't expire" merged-cell note. */
const DOES_NOT_EXPIRE_RE = /don[''\u2019]?t\s+expire/i;

/**
 * Parse the "Libres" sheet.
 *
 * Key structural differences from Test Strips:
 *   - Has Short Dates and Damaged columns with real prices.
 *   - Ding rule applies to rows 2-7 only (the D2:D7 merge), NOT to readers
 *     or the meter. So ding is checked per-row, not per-block.
 *   - Readers (rows 8-10) don't expire: the C8:D10 merge says so. Their
 *     mint price gets a null date range, and short-date/ding are skipped.
 */
export function parseLibre(ws: Worksheet): ParseResult {
  const prices: ParsedBasePrice[] = [];
  const rules: ParsedAdjustmentRule[] = [];
  const warnings: string[] = [];
  const rulesByScopeKey = new Map<string, ParsedAdjustmentRule>();

  const headerRows = findHeaderRows(ws);
  if (headerRows.length === 0) {
    warnings.push("No header rows found in Libres sheet");
    return { prices, rules, warnings };
  }

  const maxRow = ws.rowCount;
  const maxCol = ws.columnCount;

  for (let hi = 0; hi < headerRows.length; hi++) {
    const headerRow = headerRows[hi]!;
    const nextHeaderRow = headerRows[hi + 1] ?? maxRow + 1;

    // ---- classify columns ----
    let productCol: number | null = null;
    let dingCol: number | null = null;

    type PriceColDef = {
      col: number;
      condition: "mint" | "damaged" | "short_date";
      range: DateRange | null; // null = determined per-row (for mint, depends on expiry)
    };
    const priceCols: PriceColDef[] = [];
    let mintRange: DateRange | null = null; // the header-level range for expiring products

    for (let c = 1; c <= maxCol; c++) {
      const label = cellText(ws, headerRow, c);
      const role: ColumnRole = classifyColumn(label);

      if (role.role === "product") productCol = c;
      else if (role.role === "ding") dingCol = c;
      else if (role.role === "mintTier") {
        mintRange = role.range;
        priceCols.push({ col: c, condition: "mint", range: null }); // range set per-row
      } else if (role.role === "shortDate") {
        priceCols.push({ col: c, condition: "short_date", range: null });
      } else if (role.role === "damaged") {
        priceCols.push({ col: c, condition: "damaged", range: null });
      }
    }

    if (productCol === null) {
      warnings.push(`Header at row ${headerRow}: no product column found`);
      continue;
    }

    // ---- find the short-date column index for "don't expire" detection ----
    const shortDateCol = priceCols.find((pc) => pc.condition === "short_date")?.col ?? null;

    // ---- iterate data rows ----
    for (let r = headerRow + 1; r < nextHeaderRow; r++) {
      const name = cellText(ws, r, productCol);
      if (!name) continue;

      // Check if this row is a non-expiring item (readers).
      // The signal is the "DON'T EXPIRE" text in the short-date or ding cell.
      const shortDateText = shortDateCol !== null ? cellText(ws, r, shortDateCol) : "";
      const doesNotExpire = DOES_NOT_EXPIRE_RE.test(shortDateText);

      // ---- per-row ding detection ----
      let rowDingScopeKey: string | null = null;
      if (dingCol !== null) {
        const dingText = cellText(ws, r, dingCol);
        const delta = parseDingDelta(dingText);
        if (delta !== null) {
          const scopeKey = `${CATEGORY}:ding:${Math.abs(delta)}`;
          rowDingScopeKey = scopeKey;

          if (!rulesByScopeKey.has(scopeKey)) {
            rulesByScopeKey.set(scopeKey, {
              scopeKey,
              deltaAmount: String(delta),
              note: dingText,
              sourceSheet: SHEET_NAME,
            });
          }
        }
        // If delta is null (e.g. "DON'T EXPIRE" text, or empty), no ding for this row.
      }

      let emittedAny = false;

      for (const pc of priceCols) {
        const priceStr = cellPrice(ws, r, pc.col);
        if (priceStr === null) continue;

        // Determine date range for this specific cell:
        let dateFrom: Date | null = null;
        let dateTo: Date | null = null;

        if (pc.condition === "mint") {
          if (doesNotExpire) {
            // Readers: null range, item has no expiration date
            dateFrom = null;
            dateTo = null;
          } else if (mintRange) {
            dateFrom = mintRange.from;
            dateTo = mintRange.to;
          }
        }
        // damaged and short_date are always flat (null range)

        prices.push({
          category: CATEGORY,
          productName: name,
          reference: null,
          condition: pc.condition,
          dateFrom,
          dateTo,
          price: priceStr,
          dingRuleKey: pc.condition === "mint" ? rowDingScopeKey : null,
          sourceSheet: SHEET_NAME,
          sourceRow: r,
        });
        emittedAny = true;
      }

      if (!emittedAny) {
        warnings.push(
          `Row ${r}: "${name}" has no purchasable prices (all N/A).`,
        );
      }
    }
  }

  for (const rule of rulesByScopeKey.values()) {
    rules.push(rule);
  }

  return { prices, rules, warnings };
}
