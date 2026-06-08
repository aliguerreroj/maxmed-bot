import { describe, it, expect, beforeAll } from "vitest";
import ExcelJS from "exceljs";
import { parseDexcom } from "../src/parsers/dexcom.js";
import type { ParseResult, ParsedBasePrice, ParsedAdjustmentRule } from "../src/parsers/types.js";

let result: ParseResult;
let g6Prices: ParsedBasePrice[];
let g7Prices: ParsedBasePrice[];

beforeAll(async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile("data/price-sheet.xlsx");
  const ws = wb.getWorksheet("G6G7")!;
  result = parseDexcom(ws);
  g6Prices = result.prices.filter((p) => p.category === "dexcom_g6");
  g7Prices = result.prices.filter((p) => p.category === "dexcom_g7");
});

function pricesFor(
  cat: string,
  name: string,
  ref?: string,
  condition?: string,
): ParsedBasePrice[] {
  return result.prices.filter(
    (p) =>
      p.category === cat &&
      p.productName === name &&
      (ref === undefined || p.reference === ref) &&
      (condition === undefined || p.condition === condition),
  );
}

function ruleByKey(key: string): ParsedAdjustmentRule | undefined {
  return result.rules.find((r) => r.scopeKey === key);
}

// ========== overall structure ==========

describe("overall structure", () => {
  it("emits 48 total price rows", () => {
    expect(result.prices.length).toBe(48);
  });

  it("splits into 30 G6 + 18 G7", () => {
    expect(g6Prices.length).toBe(30);
    expect(g7Prices.length).toBe(18);
  });

  it("emits 3 ding rules", () => {
    expect(result.rules.length).toBe(3);
  });

  it("warns about 7 all-N/A receiver rows", () => {
    const receiverWarnings = result.warnings.filter((w) =>
      w.includes("RECEIVER"),
    );
    expect(receiverWarnings.length).toBe(7);
  });
});

// ========== ding rules ==========

describe("ding rules", () => {
  it("G6 has one unified −10 rule", () => {
    const r = ruleByKey("dexcom_g6:ding:10");
    expect(r).toBeDefined();
    expect(r!.deltaAmount).toBe("-10");
  });

  it("G7 sensors have a −5 rule", () => {
    const r = ruleByKey("dexcom_g7:ding:5");
    expect(r).toBeDefined();
    expect(r!.deltaAmount).toBe("-5");
  });

  it("G7 receivers have a separate −10 rule", () => {
    const r = ruleByKey("dexcom_g7:ding:10");
    expect(r).toBeDefined();
    expect(r!.deltaAmount).toBe("-10");
    expect(r!.note).toContain("recievers"); // typo preserved from sheet
  });
});

// ========== G6 sensors ==========

describe("G6 SENSOR 3 PACK OE (reference discrimination)", () => {
  it("has 5 rows: 4 mint tiers + 1 damaged", () => {
    expect(pricesFor("dexcom_g6", "DEXCOM SENSOR 3 PACK", "OE").length).toBe(5);
  });

  it("mint 12/2026+ = $250", () => {
    const tier = pricesFor("dexcom_g6", "DEXCOM SENSOR 3 PACK", "OE", "mint")
      .find((p) => p.dateTo === null);
    expect(tier).toBeDefined();
    expect(tier!.price).toBe("250");
  });

  it("mint 9/2026 (floor) = $150", () => {
    const tier = pricesFor("dexcom_g6", "DEXCOM SENSOR 3 PACK", "OE", "mint")
      .find((p) => p.dateFrom?.toISOString().startsWith("2026-09"));
    expect(tier).toBeDefined();
    expect(tier!.price).toBe("150");
  });

  it("damaged = $150 with null date range", () => {
    const dmg = pricesFor("dexcom_g6", "DEXCOM SENSOR 3 PACK", "OE", "damaged");
    expect(dmg.length).toBe(1);
    expect(dmg[0]!.price).toBe("150");
    expect(dmg[0]!.dateFrom).toBeNull();
  });

  it("same product name, different reference OM has different prices", () => {
    const omTop = pricesFor("dexcom_g6", "DEXCOM SENSOR 3 PACK", "OM", "mint")
      .find((p) => p.dateTo === null);
    expect(omTop!.price).toBe("190"); // vs OE's 250
  });
});

describe("G6 multi-code reference", () => {
  it("OR & OM reference preserved as-is", () => {
    const rows = pricesFor("dexcom_g6", "DEXCOM SENSOR 1 PACK (BOX)", "OR & OM");
    expect(rows.length).toBe(5); // 4 mint + 1 damaged
  });
});

describe("G6 partial-N/A product", () => {
  it("NO BOX/LOOSE has only 1 mint tier (12/2026+ only)", () => {
    const rows = pricesFor(
      "dexcom_g6",
      "DEXCOM SENSOR 1 PACK (NO BOX/LOOSE)",
      "OR & OM",
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.condition).toBe("mint");
    expect(rows[0]!.price).toBe("40");
  });
});

// ========== note rows skipped ==========

describe("note rows", () => {
  it("no prices at source rows 8 or 26 (note rows)", () => {
    const noteRowPrices = result.prices.filter(
      (p) => p.sourceRow === 8 || p.sourceRow === 26,
    );
    expect(noteRowPrices.length).toBe(0);
  });
});

// ========== G6 receivers (all N/A) ==========

describe("G6 receivers", () => {
  it("emit zero price rows", () => {
    expect(
      pricesFor("dexcom_g6", "DEXCOM RECEIVER 1 PACK").length,
    ).toBe(0);
  });
});

// ========== G6 transmitters ==========

describe("G6 transmitters", () => {
  it("TRASNMITTER KIT OE has 2 rows: 1 mint + 1 damaged", () => {
    const rows = pricesFor("dexcom_g6", "DEXCOM TRASNMITTER KIT", "OE");
    expect(rows.length).toBe(2);
    expect(rows.find((p) => p.condition === "mint")!.price).toBe("150");
    expect(rows.find((p) => p.condition === "damaged")!.price).toBe("50");
  });

  it("preserves the TRASNMITTER typo", () => {
    expect(
      pricesFor("dexcom_g6", "DEXCOM TRASNMITTER KIT").length,
    ).toBeGreaterThan(0);
  });

  it("transmitter mint rows link to the shared G6 ding rule", () => {
    const mint = pricesFor("dexcom_g6", "DEXCOM TRASNMITTER KIT", "OE", "mint");
    expect(mint[0]!.dingRuleKey).toBe("dexcom_g6:ding:10");
  });
});

// ========== G7 sensors ==========

describe("G7 sensors", () => {
  it("leading-zero reference preserved: 012", () => {
    const rows = pricesFor("dexcom_g7", "DEXCOM SENSOR 1 PACK (15 Day)", "012");
    expect(rows.length).toBe(2); // 1 mint + 1 damaged
  });

  it("013 (15 Day) has a different mint price than 012", () => {
    const r013 = pricesFor("dexcom_g7", "DEXCOM SENSOR 1 PACK (15 Day)", "013", "mint");
    const r012 = pricesFor("dexcom_g7", "DEXCOM SENSOR 1 PACK (15 Day)", "012", "mint");
    expect(r013[0]!.price).toBe("120");
    expect(r012[0]!.price).toBe("100");
  });

  it("G7 sensor mint rows link to the −5 rule, not −10", () => {
    const mint = pricesFor("dexcom_g7", "DEXCOM SENSOR 1 PACK (15 Day)", "012", "mint");
    expect(mint[0]!.dingRuleKey).toBe("dexcom_g7:ding:5");
  });

  it("Non-15 Day 030 has lower damaged price ($20 vs $50)", () => {
    const dmg = pricesFor("dexcom_g7", "DEXCOM SENSOR 1 PACK (Non-15 Day)", "030", "damaged");
    expect(dmg[0]!.price).toBe("20");
  });
});

// ========== G7 receivers (all N/A) ==========

describe("G7 receivers", () => {
  it("emit zero price rows", () => {
    expect(
      pricesFor("dexcom_g7", "DEXCOM RECEIVER 1 PACK").length,
    ).toBe(0);
  });
});

// ========== grounding invariant ==========

describe("grounding invariant", () => {
  it("every price is a positive number", () => {
    for (const p of result.prices) {
      expect(Number(p.price)).toBeGreaterThan(0);
    }
  });

  it("every mint row has a dateFrom", () => {
    for (const p of result.prices) {
      if (p.condition === "mint") {
        expect(p.dateFrom).not.toBeNull();
      }
    }
  });

  it("every damaged row has null date range", () => {
    for (const p of result.prices) {
      if (p.condition === "damaged") {
        expect(p.dateFrom).toBeNull();
        expect(p.dateTo).toBeNull();
      }
    }
  });

  it("ding links exist only on mint rows", () => {
    for (const p of result.prices) {
      if (p.condition !== "mint") {
        expect(p.dingRuleKey).toBeNull();
      }
    }
  });

  it("every row has a reference (Dexcom requires it)", () => {
    for (const p of result.prices) {
      expect(p.reference).not.toBeNull();
      expect(p.reference!.length).toBeGreaterThan(0);
    }
  });

  it("no condition value is outside the known set", () => {
    const known = new Set(["mint", "damaged", "short_date", "expired"]);
    for (const p of result.prices) {
      expect(known.has(p.condition)).toBe(true);
    }
  });
});
