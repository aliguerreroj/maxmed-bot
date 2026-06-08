import { describe, it, expect, beforeAll } from "vitest";
import ExcelJS from "exceljs";
import { parseLibre } from "../src/parsers/libre.js";
import type { ParseResult, ParsedBasePrice } from "../src/parsers/types.js";

let result: ParseResult;

beforeAll(async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile("data/price-sheet.xlsx");
  const ws = wb.getWorksheet("Libres")!;
  result = parseLibre(ws);
});

function pricesFor(name: string, condition?: string): ParsedBasePrice[] {
  return result.prices.filter(
    (p) =>
      p.productName === name &&
      (condition === undefined || p.condition === condition),
  );
}

// ========== structure ==========

describe("overall structure", () => {
  it("emits 23 total price rows", () => {
    expect(result.prices.length).toBe(23);
  });

  it("emits exactly one ding rule", () => {
    expect(result.rules.length).toBe(1);
  });

  it("every row has category libre", () => {
    expect(result.prices.every((p) => p.category === "libre")).toBe(true);
  });

  it("no row has a reference (Libre has no reference column)", () => {
    expect(result.prices.every((p) => p.reference === null)).toBe(true);
  });
});

// ========== ding rule ==========

describe("ding rule", () => {
  it("has delta -3 with scopeKey libre:ding:3", () => {
    expect(result.rules[0]!.scopeKey).toBe("libre:ding:3");
    expect(result.rules[0]!.deltaAmount).toBe("-3");
  });

  it("is separate from the test_strips ding rule", () => {
    // scopeKey includes category prefix
    expect(result.rules[0]!.scopeKey).not.toContain("test_strips");
  });
});

// ========== standard products (rows 2-7, ding applies) ==========

describe("FREESTYLE LIBRE 3 (standard product)", () => {
  it("has 3 rows: mint + short_date + damaged", () => {
    expect(pricesFor("FREESTYLE LIBRE 3").length).toBe(3);
  });

  it("mint = $55 with 9/2026+ date range", () => {
    const mint = pricesFor("FREESTYLE LIBRE 3", "mint");
    expect(mint.length).toBe(1);
    expect(mint[0]!.price).toBe("55");
    expect(mint[0]!.dateFrom).toEqual(new Date(Date.UTC(2026, 8, 1)));
    expect(mint[0]!.dateTo).toBeNull();
  });

  it("short_date = $5 with null date range", () => {
    const sd = pricesFor("FREESTYLE LIBRE 3", "short_date");
    expect(sd.length).toBe(1);
    expect(sd[0]!.price).toBe("5");
    expect(sd[0]!.dateFrom).toBeNull();
  });

  it("damaged = $27 with null date range", () => {
    const dmg = pricesFor("FREESTYLE LIBRE 3", "damaged");
    expect(dmg.length).toBe(1);
    expect(dmg[0]!.price).toBe("27");
  });

  it("mint row links to the ding rule", () => {
    const mint = pricesFor("FREESTYLE LIBRE 3", "mint");
    expect(mint[0]!.dingRuleKey).toBe("libre:ding:3");
  });

  it("non-mint rows do NOT link to the ding rule", () => {
    const others = pricesFor("FREESTYLE LIBRE 3").filter(
      (p) => p.condition !== "mint",
    );
    expect(others.every((p) => p.dingRuleKey === null)).toBe(true);
  });
});

// ========== NFR products (no damaged price) ==========

describe("NFR products", () => {
  it("LIBRE 3 PLUS (NFR) has 2 rows: mint + short_date, no damaged", () => {
    const rows = pricesFor("FREESTYLE LIBRE 3 PLUS (NFR)");
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.condition).sort()).toEqual(["mint", "short_date"]);
  });

  it("LIBRE 2 PLUS (NFR) has 2 rows: mint + short_date, no damaged", () => {
    const rows = pricesFor("LIBRE 2 PLUS (NFR)");
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.condition).sort()).toEqual(["mint", "short_date"]);
  });
});

// ========== readers (non-expiring, no ding, no short_date) ==========

describe("readers (non-expiring)", () => {
  const readerNames = [
    "FREESTYLE LIBRE 3 READER",
    "FREETYLE LIBRE 2 READER", // typo preserved from sheet
    "FREESTYLE LIBRE 14 DAY READER",
  ];

  it("each reader has 2 rows: mint + damaged", () => {
    for (const name of readerNames) {
      const rows = pricesFor(name);
      expect(rows.length).toBe(2);
      expect(rows.map((r) => r.condition).sort()).toEqual(["damaged", "mint"]);
    }
  });

  it("reader mint prices have NULL date range (non-expiring)", () => {
    for (const name of readerNames) {
      const mint = pricesFor(name, "mint");
      expect(mint[0]!.dateFrom).toBeNull();
      expect(mint[0]!.dateTo).toBeNull();
    }
  });

  it("readers have NO ding link", () => {
    for (const name of readerNames) {
      const rows = pricesFor(name);
      expect(rows.every((p) => p.dingRuleKey === null)).toBe(true);
    }
  });

  it("readers have NO short_date rows", () => {
    for (const name of readerNames) {
      expect(pricesFor(name, "short_date").length).toBe(0);
    }
  });

  it("preserves the FREETYLE typo from the sheet", () => {
    expect(pricesFor("FREETYLE LIBRE 2 READER").length).toBeGreaterThan(0);
  });
});

// ========== meter ==========

describe("FREESTYLE METER", () => {
  it("has 1 row: mint only", () => {
    const rows = pricesFor("FREESTYLE METER");
    expect(rows.length).toBe(1);
    expect(rows[0]!.condition).toBe("mint");
    expect(rows[0]!.price).toBe("10");
  });

  it("uses the standard 9/2026+ date range (not non-expiring)", () => {
    const mint = pricesFor("FREESTYLE METER", "mint");
    expect(mint[0]!.dateFrom).toEqual(new Date(Date.UTC(2026, 8, 1)));
    expect(mint[0]!.dateTo).toBeNull();
  });

  it("has no ding link", () => {
    expect(pricesFor("FREESTYLE METER", "mint")[0]!.dingRuleKey).toBeNull();
  });
});

// ========== grounding invariant ==========

describe("grounding invariant", () => {
  it("every price is a positive number", () => {
    for (const p of result.prices) {
      expect(Number(p.price)).toBeGreaterThan(0);
    }
  });

  it("no condition value is outside the known set", () => {
    const known = new Set(["mint", "damaged", "short_date", "expired"]);
    for (const p of result.prices) {
      expect(known.has(p.condition)).toBe(true);
    }
  });

  it("ding links exist only on mint rows", () => {
    for (const p of result.prices) {
      if (p.condition !== "mint") {
        expect(p.dingRuleKey).toBeNull();
      }
    }
  });
});
