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

const SHEET_NAME = "G6G7";

/** Map the header cell label to a category. */
function categoryFromHeader(label: string): string {
  const l = label.trim().toLowerCase();
  if (l === "g6") return "dexcom_g6";
  if (l === "g7") return "dexcom_g7";
  return `dexcom_${l}`;
}

/** Detect full-width note rows ("Receivers do not expire...") by checking if
 *  the product cell and reference cell carry the same merged text. Real data
 *  rows always have distinct values in these two columns. */
function isNoteRow(ws: Worksheet, row: number, productCol: number, referenceCol: number | null): boolean {
  if (referenceCol === null) return false;
  const a = cellText(ws, row, productCol);
  const b = cellText(ws, row, referenceCol);
  return a !== "" && a === b;
}

const DOES_NOT_EXPIRE_RE = /do\s*n.?t\s+expire|do\s+not\s+expire/i;

/**
 * Parse the "G6G7" sheet. Both the G6 block (header row 1) and G7 block
 * (header row 16) are handled by the same loop — the category is derived
 * from each header's label.
 *
 * Key structural features:
 *   - REFERENCE column: identity = (category, productName, reference).
 *   - Full-width note rows ("Receivers do not expire...") must be skipped.
 *   - Ding varies within G7: sensors −5, receivers −10. Per-row detection
 *     produces separate scopeKeys automatically.
 *   - Receivers have zero purchasable prices (all N/A); the ding rules
 *     exist but no mint rows currently link to them.
 */
export function parseDexcom(ws: Worksheet): ParseResult {
  const prices: ParsedBasePrice[] = [];
  const rules: ParsedAdjustmentRule[] = [];
  const warnings: string[] = [];
  const rulesByScopeKey = new Map<string, ParsedAdjustmentRule>();

  const headerRows = findHeaderRows(ws);
  if (headerRows.length === 0) {
    warnings.push("No header rows found in G6G7 sheet");
    return { prices, rules, warnings };
  }

  const maxRow = ws.rowCount;
  const maxCol = ws.columnCount;

  for (let hi = 0; hi < headerRows.length; hi++) {
    const headerRow = headerRows[hi]!;
    const nextHeaderRow = headerRows[hi + 1] ?? maxRow + 1;

    // ---- derive category from the header label ----
    const headerLabel = cellText(ws, headerRow, 1);
    const category = categoryFromHeader(headerLabel);

    // ---- classify columns ----
    let productCol: number | null = null;
    let referenceCol: number | null = null;
    let dingCol: number | null = null;

    type PriceColDef = {
      col: number;
      condition: "mint" | "damaged";
      range: DateRange | null;
    };
    const mintTierCols: Array<{ col: number; range: DateRange }> = [];
    const priceCols: PriceColDef[] = [];

    for (let c = 1; c <= maxCol; c++) {
      const label = cellText(ws, headerRow, c);
      const role: ColumnRole = classifyColumn(label);

      if (role.role === "product") productCol = c;
      else if (role.role === "reference") referenceCol = c;
      else if (role.role === "ding") dingCol = c;
      else if (role.role === "mintTier") {
        mintTierCols.push({ col: c, range: role.range });
        priceCols.push({ col: c, condition: "mint", range: role.range });
      } else if (role.role === "damaged") {
        priceCols.push({ col: c, condition: "damaged", range: null });
      }
    }

    if (productCol === null) {
      warnings.push(`Header at row ${headerRow}: no product column found`);
      continue;
    }

    // ---- iterate data rows ----
    for (let r = headerRow + 1; r < nextHeaderRow; r++) {
      const name = cellText(ws, r, productCol);
      if (!name) continue; // blank separator

      // Skip full-width note rows
      if (isNoteRow(ws, r, productCol, referenceCol)) continue;

      const reference = referenceCol !== null ? cellText(ws, r, referenceCol) || null : null;

      // Detect non-expiring items: if any date-tier column for this row
      // contains "don't expire" text, the item has no expiration date.
      const doesNotExpire = mintTierCols.some((tc) =>
        DOES_NOT_EXPIRE_RE.test(cellText(ws, r, tc.col)),
      );

      // ---- per-row ding detection ----
      let rowDingScopeKey: string | null = null;
      if (dingCol !== null) {
        const dingText = cellText(ws, r, dingCol);
        const delta = parseDingDelta(dingText);
        if (delta !== null) {
          const scopeKey = `${category}:ding:${Math.abs(delta)}`;
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
      }

      let emittedAny = false;

      for (const pc of priceCols) {
        const priceStr = cellPrice(ws, r, pc.col);
        if (priceStr === null) continue;

        let dateFrom: Date | null = null;
        let dateTo: Date | null = null;

        if (pc.condition === "mint") {
          if (doesNotExpire) {
            // Non-expiring item (receivers): null date range
            dateFrom = null;
            dateTo = null;
          } else if (pc.range) {
            dateFrom = pc.range.from;
            dateTo = pc.range.to;
          }
        }
        // damaged is always flat (null range)

        prices.push({
          category,
          productName: name,
          reference,
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
          `Row ${r}: "${name}" (ref: ${reference ?? "none"}) has no purchasable prices (all N/A).`,
        );
      }
    }
  }

  for (const rule of rulesByScopeKey.values()) {
    rules.push(rule);
  }

  return { prices, rules, warnings };
}
