import { describe, it, expect, beforeAll } from "vitest";
import ExcelJS from "exceljs";
import { parseTestStrips } from "../src/parsers/testStrips.js";
import type { ParseResult, ParsedBasePrice } from "../src/parsers/types.js";

let result: ParseResult;

beforeAll(async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile("data/price-sheet.xlsx");
  const ws = wb.getWorksheet("Test Strips")!;
  result = parseTestStrips(ws);
});

// --- helpers ---
function pricesFor(
  name: string,
  condition?: string,
): ParsedBasePrice[] {
  return result.prices.filter(
    (p) =>
      p.productName === name &&
      (condition === undefined || p.condition === condition),
  );
}

// ========== structure ==========

describe("overall structure", () => {
  it("emits the correct total number of price rows", () => {
    expect(result.prices.length).toBe(65);
  });

  it("emits exactly one ding rule", () => {
    expect(result.rules.length).toBe(1);
  });

  it("every price row has category test_strips", () => {
    expect(result.prices.every((p) => p.category === "test_strips")).toBe(true);
  });

  it("no price row has a reference (test strips have no reference column)", () => {
    expect(result.prices.every((p) => p.reference === null)).toBe(true);
  });
});

// ========== ding rule ==========

describe("ding rule", () => {
  it("has delta -3", () => {
    expect(result.rules[0]!.deltaAmount).toBe("-3");
  });

  it("has a human-readable scopeKey", () => {
    expect(result.rules[0]!.scopeKey).toBe("test_strips:ding:3");
  });

  it("preserves verbatim note text from the sheet", () => {
    expect(result.rules[0]!.note).toContain("-3$");
  });
});

// ========== block 1 (rows 2-27): multi-tier products ==========

describe("block 1: Accu-Chek Aviva plus 100", () => {
  it("has 3 mint tiers + 1 expired = 4 rows", () => {
    expect(pricesFor("Accu-Chek Aviva plus 100").length).toBe(4);
  });

  it("mint tier 4/2027+ = $60", () => {
    const tier = pricesFor("Accu-Chek Aviva plus 100", "mint").find(
      (p) => p.dateTo === null,
    );
    expect(tier).toBeDefined();
    expect(tier!.price).toBe("60");
  });

  it("mint tier 12/2026-3/2027 = $50", () => {
    const tier = pricesFor("Accu-Chek Aviva plus 100", "mint").find(
      (p) =>
        p.dateFrom?.toISOString().startsWith("2026-12") &&
        p.dateTo?.toISOString().startsWith("2027-03"),
    );
    expect(tier).toBeDefined();
    expect(tier!.price).toBe("50");
  });

  it("mint tier 11/2026 (floor) = $40", () => {
    const tier = pricesFor("Accu-Chek Aviva plus 100", "mint").find(
      (p) => p.dateFrom?.toISOString().startsWith("2026-11"),
    );
    expect(tier).toBeDefined();
    expect(tier!.price).toBe("40");
    // Floor tier has both dateFrom and dateTo set (single month)
    expect(tier!.dateTo).not.toBeNull();
  });

  it("expired = $25 with null date range", () => {
    const exp = pricesFor("Accu-Chek Aviva plus 100", "expired");
    expect(exp.length).toBe(1);
    expect(exp[0]!.price).toBe("25");
    expect(exp[0]!.dateFrom).toBeNull();
    expect(exp[0]!.dateTo).toBeNull();
  });

  it("all mint rows link to the ding rule", () => {
    const mints = pricesFor("Accu-Chek Aviva plus 100", "mint");
    expect(mints.every((p) => p.dingRuleKey === "test_strips:ding:3")).toBe(
      true,
    );
  });

  it("expired row does NOT link to the ding rule", () => {
    const exp = pricesFor("Accu-Chek Aviva plus 100", "expired");
    expect(exp[0]!.dingRuleKey).toBeNull();
  });
});

// ========== N/A handling ==========

describe("N/A handling", () => {
  it("all-N/A product (Guide 50 MO) emits zero price rows", () => {
    expect(pricesFor("Accu-Chek Guide 50 MO").length).toBe(0);
  });

  it("warns about all-N/A products", () => {
    expect(
      result.warnings.some((w) => w.includes("Accu-Chek Guide 50 MO")),
    ).toBe(true);
  });

  it("partial-N/A product (Freestyle Lite 100) emits only non-N/A tiers", () => {
    // Sheet: 40 | 40 | N/A | N/A → 2 mint tiers, 0 expired
    expect(pricesFor("Freestyle Lite 100").length).toBe(2);
    expect(pricesFor("Freestyle Lite 100", "mint").length).toBe(2);
  });

  it("single-price product (Contour 50ct MO) emits 1 row", () => {
    // Sheet: 8 | N/A | N/A | N/A → 1 mint tier
    const rows = pricesFor("Contour 50ct MO");
    expect(rows.length).toBe(1);
    expect(rows[0]!.price).toBe("8");
  });
});

// ========== block 2 (rows 30-38): One Touch single-tier ==========

describe("block 2: One Touch products", () => {
  it("One Touch Ultra 100 has 1 mint row (6/2027+ only)", () => {
    const rows = pricesFor("One Touch Ultra 100");
    expect(rows.length).toBe(1);
    expect(rows[0]!.condition).toBe("mint");
    expect(rows[0]!.price).toBe("40");
    expect(rows[0]!.dateFrom).toEqual(new Date(Date.UTC(2027, 5, 1)));
    expect(rows[0]!.dateTo).toBeNull();
  });

  it("One Touch Verio 25 has 1 row at $5", () => {
    const rows = pricesFor("One Touch Verio 25");
    expect(rows.length).toBe(1);
    expect(rows[0]!.price).toBe("5");
  });

  it("One Touch rows still link to the shared ding rule", () => {
    const rows = pricesFor("One Touch Ultra 100", "mint");
    expect(rows[0]!.dingRuleKey).toBe("test_strips:ding:3");
  });

  it("block 2 has 8 products × 1 tier = 8 price rows", () => {
    const block2Products = result.prices.filter(
      (p) => p.productName.startsWith("One Touch"),
    );
    expect(block2Products.length).toBe(8);
  });
});

// ========== grounding invariant ==========

describe("grounding invariant", () => {
  it("every price is a positive number", () => {
    for (const p of result.prices) {
      const n = Number(p.price);
      expect(n).toBeGreaterThan(0);
      expect(Number.isFinite(n)).toBe(true);
    }
  });

  it("every mint row has a dateFrom", () => {
    const mints = result.prices.filter((p) => p.condition === "mint");
    for (const p of mints) {
      expect(p.dateFrom).not.toBeNull();
    }
  });

  it("every expired row has null date range", () => {
    const expired = result.prices.filter((p) => p.condition === "expired");
    for (const p of expired) {
      expect(p.dateFrom).toBeNull();
      expect(p.dateTo).toBeNull();
    }
  });

  it("no condition value is outside the known set", () => {
    const known = new Set(["mint", "damaged", "short_date", "expired"]);
    for (const p of result.prices) {
      expect(known.has(p.condition)).toBe(true);
    }
  });
});
