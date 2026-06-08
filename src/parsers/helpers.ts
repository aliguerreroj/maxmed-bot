import type { Worksheet } from "exceljs";

/**
 * Read the effective text value of a cell, resolving merged-cell masters.
 * Returns "" for null/undefined cells.
 */
export function cellText(ws: Worksheet, row: number, col: number): string {
  const cell = ws.getCell(row, col);
  const v = cell.value;
  if (v == null) return "";
  // ExcelJS can return rich text as { richText: [...] }
  if (typeof v === "object" && "richText" in v) {
    return (v as { richText: Array<{ text: string }> }).richText
      .map((r) => r.text)
      .join("")
      .trim();
  }
  return String(v).trim();
}

/**
 * True if the cell text represents "not purchased" — either blank or N/A.
 */
export function isNA(text: string): boolean {
  return text === "" || /^n\/?a$/i.test(text);
}

/**
 * Try to read a cell as a numeric price string.
 * Returns the string representation or null if not a valid number.
 */
export function cellPrice(ws: Worksheet, row: number, col: number): string | null {
  const raw = cellText(ws, row, col);
  if (isNA(raw)) return null;
  const n = Number(raw);
  if (Number.isNaN(n)) return null;
  return String(n);
}

/** Extract the ding delta from rule text like "we take -3$ off the mint price". */
export function parseDingDelta(text: string): number | null {
  // Match patterns like "-3$", "-$3", "take -3$", "-10$"
  const m = text.match(/-\s*\$?\s*(\d+)\s*\$?/);
  if (m?.[1]) return -Number(m[1]);
  return null;
}

/**
 * Detect all header rows in a sheet — rows where column 1 contains a
 * "product" / block-identifier keyword.
 */
export function findHeaderRows(ws: Worksheet): number[] {
  const headers: number[] = [];
  const maxRow = ws.rowCount;
  for (let r = 1; r <= maxRow; r++) {
    const t = cellText(ws, r, 1).toLowerCase();
    if (t === "product" || t === "libre" || t === "g6" || t === "g7") {
      headers.push(r);
    }
  }
  return headers;
}
