/**
 * Grounding evals for the price-lookup engine.
 *
 * These tests parse the REAL price sheet, convert to engine format, and run
 * lookups. Every assertion is against the actual data the import would load,
 * not synthetic fixtures. This means a price-sheet edit that changes a number
 * will cause exactly the right test to fail.
 *
 * The test structure mirrors the bot's flow:
 *   Excel → parser → PriceRow[] + DingRule[] → lookupPrice() → result
 */

import { describe, it, expect, beforeAll } from "vitest";
import ExcelJS from "exceljs";
import { parseTestStrips } from "../src/parsers/testStrips.js";
import { parseLibre } from "../src/parsers/libre.js";
import { parseDexcom } from "../src/parsers/dexcom.js";
import { lookupPrice } from "../src/engine/lookup.js";
import type {
  PriceRow,
  DingRule,
  PriceLookupRequest,
  PriceLookupResult,
} from "../src/engine/types.js";
import type { ParsedBasePrice, ParsedAdjustmentRule } from "../src/parsers/types.js";

// ---- test harness: load real data once ----

let allRows: PriceRow[];
let rulesMap: Map<string, DingRule>;

/** Fixed "today" for deterministic tests. */
const TODAY = new Date(Date.UTC(2026, 5, 8)); // June 8, 2026

function utc(y: number, m: number, d: number = 1): Date {
  return new Date(Date.UTC(y, m - 1, d));
}

function lookup(
  req: Partial<PriceLookupRequest> & Pick<PriceLookupRequest, "category" | "productName" | "condition">,
): PriceLookupResult {
  const full: PriceLookupRequest = {
    reference: null,
    expirationDate: null,
    ...req,
  };

  // Pre-filter rows the way the bot handler would (exact match on identity).
  const filtered = allRows.filter(
    (r) =>
      r.category === full.category &&
      r.productName === full.productName &&
      r.reference === full.reference,
  );

  return lookupPrice(full, filtered, rulesMap, TODAY);
}

beforeAll(async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile("data/price-sheet.xlsx");

  const parsedPrices: ParsedBasePrice[] = [];
  const parsedRules: ParsedAdjustmentRule[] = [];

  const ts = parseTestStrips(wb.getWorksheet("Test Strips")!);
  const lib = parseLibre(wb.getWorksheet("Libres")!);
  const dex = parseDexcom(wb.getWorksheet("G6G7")!);

  parsedPrices.push(...ts.prices, ...lib.prices, ...dex.prices);
  parsedRules.push(...ts.rules, ...lib.rules, ...dex.rules);

  // Convert to engine format with sequential IDs.
  allRows = parsedPrices.map((p, i) => ({
    id: i + 1,
    category: p.category,
    productName: p.productName,
    reference: p.reference,
    condition: p.condition,
    dateFrom: p.dateFrom,
    dateTo: p.dateTo,
    price: Number(p.price),
    dingRuleKey: p.dingRuleKey,
  }));

  rulesMap = new Map(
    parsedRules.map((r, i) => [
      r.scopeKey,
      { id: i + 1, scopeKey: r.scopeKey, deltaAmount: Number(r.deltaAmount) },
    ]),
  );
});

// ========================================================================
// TEST STRIPS
// ========================================================================

describe("Test Strips: mint date-tier matching", () => {
  it("Aviva 100 exp 5/2027 → $60 (4/2027+ tier)", () => {
    const r = lookup({
      category: "test_strips",
      productName: "Accu-Chek Aviva plus 100",
      condition: "mint",
      expirationDate: utc(2027, 5, 15),
    });
    expect(r.status).toBe("found");
    if (r.status === "found") {
      expect(r.finalPrice).toBe(60);
      expect(r.breakdown).toContain("$60");
      expect(r.basePriceId).toBeGreaterThan(0);
    }
  });

  it("Aviva 100 exp 1/2027 → $50 (12/2026–3/2027 tier)", () => {
    const r = lookup({
      category: "test_strips",
      productName: "Accu-Chek Aviva plus 100",
      condition: "mint",
      expirationDate: utc(2027, 1, 15),
    });
    expect(r.status).toBe("found");
    if (r.status === "found") expect(r.finalPrice).toBe(50);
  });

  it("Aviva 100 exp 11/2026 (floor) → $40", () => {
    const r = lookup({
      category: "test_strips",
      productName: "Accu-Chek Aviva plus 100",
      condition: "mint",
      expirationDate: utc(2026, 11, 15),
    });
    expect(r.status).toBe("found");
    if (r.status === "found") expect(r.finalPrice).toBe(40);
  });

  it("Aviva 100 exp 10/2026 (below floor) → not_purchased", () => {
    const r = lookup({
      category: "test_strips",
      productName: "Accu-Chek Aviva plus 100",
      condition: "mint",
      expirationDate: utc(2026, 10, 15),
    });
    expect(r.status).toBe("not_purchased");
  });

  it("tier boundary: exp exactly 12/1/2026 → $50 (enters 12/2026–3/2027)", () => {
    const r = lookup({
      category: "test_strips",
      productName: "Accu-Chek Aviva plus 100",
      condition: "mint",
      expirationDate: utc(2026, 12, 1),
    });
    expect(r.status).toBe("found");
    if (r.status === "found") expect(r.finalPrice).toBe(50);
  });

  it("tier boundary: exp exactly 4/1/2027 → $60 (enters 4/2027+)", () => {
    const r = lookup({
      category: "test_strips",
      productName: "Accu-Chek Aviva plus 100",
      condition: "mint",
      expirationDate: utc(2027, 4, 1),
    });
    expect(r.status).toBe("found");
    if (r.status === "found") expect(r.finalPrice).toBe(60);
  });
});

describe("Test Strips: ding computation", () => {
  it("Aviva 100 ding exp 5/2027 → $60 − $3 = $57", () => {
    const r = lookup({
      category: "test_strips",
      productName: "Accu-Chek Aviva plus 100",
      condition: "ding",
      expirationDate: utc(2027, 5, 15),
    });
    expect(r.status).toBe("found");
    if (r.status === "found") {
      expect(r.finalPrice).toBe(57);
      expect(r.adjustmentRuleId).toBeDefined();
      expect(r.breakdown).toContain("$60");
      expect(r.breakdown).toContain("$3");
      expect(r.breakdown).toContain("$57");
    }
  });

  it("Aviva 100 ding at floor → $40 − $3 = $37", () => {
    const r = lookup({
      category: "test_strips",
      productName: "Accu-Chek Aviva plus 100",
      condition: "ding",
      expirationDate: utc(2026, 11, 15),
    });
    expect(r.status).toBe("found");
    if (r.status === "found") expect(r.finalPrice).toBe(37);
  });

  it("ding below floor → not_purchased (no mint to base off)", () => {
    const r = lookup({
      category: "test_strips",
      productName: "Accu-Chek Aviva plus 100",
      condition: "ding",
      expirationDate: utc(2026, 10, 15),
    });
    expect(r.status).toBe("not_purchased");
  });
});

describe("Test Strips: expired condition", () => {
  it("Aviva 100 expired 2 months ago → $25", () => {
    const r = lookup({
      category: "test_strips",
      productName: "Accu-Chek Aviva plus 100",
      condition: "expired",
      expirationDate: utc(2026, 4, 1), // ~2 months before today
    });
    expect(r.status).toBe("found");
    if (r.status === "found") expect(r.finalPrice).toBe(25);
  });

  it("Aviva 100 expired exactly 6 months ago → $25 (boundary: accepted)", () => {
    // 6 months before June 8, 2026 → Dec 8, 2025
    const r = lookup({
      category: "test_strips",
      productName: "Accu-Chek Aviva plus 100",
      condition: "expired",
      expirationDate: utc(2025, 12, 8),
    });
    expect(r.status).toBe("found");
    if (r.status === "found") expect(r.finalPrice).toBe(25);
  });

  it("Aviva 100 expired 7+ months ago → expired_too_old", () => {
    const r = lookup({
      category: "test_strips",
      productName: "Accu-Chek Aviva plus 100",
      condition: "expired",
      expirationDate: utc(2025, 11, 1),
    });
    expect(r.status).toBe("expired_too_old");
  });

  it("expired with future date → not_purchased (not actually expired)", () => {
    const r = lookup({
      category: "test_strips",
      productName: "Accu-Chek Aviva plus 100",
      condition: "expired",
      expirationDate: utc(2027, 1, 1),
    });
    expect(r.status).toBe("not_purchased");
    if (r.status === "not_purchased") {
      expect(r.reason).toContain("not expired");
    }
  });
});

describe("Test Strips: One Touch (single tier, block 2)", () => {
  it("Ultra 100 exp 7/2027 → $40 (6/2027+ only tier)", () => {
    const r = lookup({
      category: "test_strips",
      productName: "One Touch Ultra 100",
      condition: "mint",
      expirationDate: utc(2027, 7, 1),
    });
    expect(r.status).toBe("found");
    if (r.status === "found") expect(r.finalPrice).toBe(40);
  });

  it("Ultra 100 exp 5/2027 (below 6/2027+ floor) → not_purchased", () => {
    const r = lookup({
      category: "test_strips",
      productName: "One Touch Ultra 100",
      condition: "mint",
      expirationDate: utc(2027, 5, 15),
    });
    expect(r.status).toBe("not_purchased");
  });

  it("Ultra 100 ding exp 7/2027 → $40 − $3 = $37", () => {
    const r = lookup({
      category: "test_strips",
      productName: "One Touch Ultra 100",
      condition: "ding",
      expirationDate: utc(2027, 7, 1),
    });
    expect(r.status).toBe("found");
    if (r.status === "found") expect(r.finalPrice).toBe(37);
  });
});

// ========================================================================
// LIBRE
// ========================================================================

describe("Libre: standard product", () => {
  it("Libre 3 mint exp 10/2026 → $55", () => {
    const r = lookup({
      category: "libre",
      productName: "FREESTYLE LIBRE 3",
      condition: "mint",
      expirationDate: utc(2026, 10, 1),
    });
    expect(r.status).toBe("found");
    if (r.status === "found") expect(r.finalPrice).toBe(55);
  });

  it("Libre 3 short_date → $5", () => {
    const r = lookup({
      category: "libre",
      productName: "FREESTYLE LIBRE 3",
      condition: "short_date",
    });
    expect(r.status).toBe("found");
    if (r.status === "found") expect(r.finalPrice).toBe(5);
  });

  it("Libre 3 damaged → $27", () => {
    const r = lookup({
      category: "libre",
      productName: "FREESTYLE LIBRE 3",
      condition: "damaged",
    });
    expect(r.status).toBe("found");
    if (r.status === "found") expect(r.finalPrice).toBe(27);
  });

  it("Libre 3 ding exp 10/2026 → $55 − $3 = $52", () => {
    const r = lookup({
      category: "libre",
      productName: "FREESTYLE LIBRE 3",
      condition: "ding",
      expirationDate: utc(2026, 10, 1),
    });
    expect(r.status).toBe("found");
    if (r.status === "found") {
      expect(r.finalPrice).toBe(52);
      expect(r.adjustmentRuleId).toBeDefined();
    }
  });
});

describe("Libre: NFR (no damaged price)", () => {
  it("Libre 3 Plus (NFR) damaged → not_purchased", () => {
    const r = lookup({
      category: "libre",
      productName: "FREESTYLE LIBRE 3 PLUS (NFR)",
      condition: "damaged",
    });
    expect(r.status).toBe("not_purchased");
  });
});

describe("Libre: readers (non-expiring)", () => {
  it("Libre 3 Reader mint → $50 (no expiration date needed)", () => {
    const r = lookup({
      category: "libre",
      productName: "FREESTYLE LIBRE 3 READER",
      condition: "mint",
    });
    expect(r.status).toBe("found");
    if (r.status === "found") {
      expect(r.finalPrice).toBe(50);
      expect(r.breakdown).toContain("non-expiring");
    }
  });

  it("Libre 3 Reader ding → not_purchased (no ding rule for readers)", () => {
    const r = lookup({
      category: "libre",
      productName: "FREESTYLE LIBRE 3 READER",
      condition: "ding",
    });
    expect(r.status).toBe("not_purchased");
  });

  it("reader with typo in sheet is found by exact name", () => {
    const r = lookup({
      category: "libre",
      productName: "FREETYLE LIBRE 2 READER",
      condition: "mint",
    });
    expect(r.status).toBe("found");
  });
});

// ========================================================================
// DEXCOM G6/G7
// ========================================================================

describe("Dexcom G6: reference discrimination", () => {
  it("SENSOR 3 PACK OE exp 1/2027 → $250 (12/2026+ tier)", () => {
    const r = lookup({
      category: "dexcom_g6",
      productName: "DEXCOM SENSOR 3 PACK",
      reference: "OE",
      condition: "mint",
      expirationDate: utc(2027, 1, 15),
    });
    expect(r.status).toBe("found");
    if (r.status === "found") expect(r.finalPrice).toBe(250);
  });

  it("same product, ref OM → different price ($190)", () => {
    const r = lookup({
      category: "dexcom_g6",
      productName: "DEXCOM SENSOR 3 PACK",
      reference: "OM",
      condition: "mint",
      expirationDate: utc(2027, 1, 15),
    });
    expect(r.status).toBe("found");
    if (r.status === "found") expect(r.finalPrice).toBe(190);
  });

  it("G6 ding: OE exp 1/2027 → $250 − $10 = $240", () => {
    const r = lookup({
      category: "dexcom_g6",
      productName: "DEXCOM SENSOR 3 PACK",
      reference: "OE",
      condition: "ding",
      expirationDate: utc(2027, 1, 15),
    });
    expect(r.status).toBe("found");
    if (r.status === "found") expect(r.finalPrice).toBe(240);
  });

  it("G6 damaged: OE → $150 (flat)", () => {
    const r = lookup({
      category: "dexcom_g6",
      productName: "DEXCOM SENSOR 3 PACK",
      reference: "OE",
      condition: "damaged",
    });
    expect(r.status).toBe("found");
    if (r.status === "found") expect(r.finalPrice).toBe(150);
  });
});

describe("Dexcom G7: leading-zero references", () => {
  it("ref '012' (15 Day) → $100", () => {
    const r = lookup({
      category: "dexcom_g7",
      productName: "DEXCOM SENSOR 1 PACK (15 Day)",
      reference: "012",
      condition: "mint",
      expirationDate: utc(2027, 1, 15),
    });
    expect(r.status).toBe("found");
    if (r.status === "found") expect(r.finalPrice).toBe(100);
  });

  it("ref '013' (15 Day) has a different price ($120)", () => {
    const r = lookup({
      category: "dexcom_g7",
      productName: "DEXCOM SENSOR 1 PACK (15 Day)",
      reference: "013",
      condition: "mint",
      expirationDate: utc(2027, 1, 15),
    });
    expect(r.status).toBe("found");
    if (r.status === "found") expect(r.finalPrice).toBe(120);
  });

  it("G7 ding: 012 → $100 − $5 = $95 (sensors use −5, not −10)", () => {
    const r = lookup({
      category: "dexcom_g7",
      productName: "DEXCOM SENSOR 1 PACK (15 Day)",
      reference: "012",
      condition: "ding",
      expirationDate: utc(2027, 1, 15),
    });
    expect(r.status).toBe("found");
    if (r.status === "found") expect(r.finalPrice).toBe(95);
  });
});

describe("Dexcom: receivers (all N/A)", () => {
  it("G6 receiver → not_found (zero rows)", () => {
    const r = lookup({
      category: "dexcom_g6",
      productName: "DEXCOM RECEIVER 1 PACK",
      reference: "OE",
      condition: "mint",
    });
    expect(r.status).toBe("not_found");
  });

  it("G7 receiver → not_found (zero rows)", () => {
    const r = lookup({
      category: "dexcom_g7",
      productName: "DEXCOM RECEIVER 1 PACK",
      reference: "012",
      condition: "mint",
    });
    expect(r.status).toBe("not_found");
  });
});

// ========================================================================
// GROUNDING INVARIANTS (cross-cutting)
// ========================================================================

describe("grounding: unknown product → not_found", () => {
  it("completely unknown product", () => {
    const r = lookup({
      category: "test_strips",
      productName: "Nonexistent Widget 9000",
      condition: "mint",
      expirationDate: utc(2027, 5, 1),
    });
    expect(r.status).toBe("not_found");
  });

  it("wrong category for known product", () => {
    const r = lookup({
      category: "libre",
      productName: "Accu-Chek Aviva plus 100",
      condition: "mint",
      expirationDate: utc(2027, 5, 1),
    });
    expect(r.status).toBe("not_found");
  });
});

describe("grounding: known product, unavailable condition → not_purchased", () => {
  it("test strips have no damaged condition", () => {
    const r = lookup({
      category: "test_strips",
      productName: "Accu-Chek Aviva plus 100",
      condition: "damaged",
    });
    expect(r.status).toBe("not_purchased");
  });

  it("Freestyle Meter has no short_date", () => {
    const r = lookup({
      category: "libre",
      productName: "FREESTYLE METER",
      condition: "short_date",
    });
    expect(r.status).toBe("not_purchased");
  });
});

describe("grounding: missing expiration date", () => {
  it("mint lookup for expiring product without exp date → not_purchased", () => {
    const r = lookup({
      category: "test_strips",
      productName: "Accu-Chek Aviva plus 100",
      condition: "mint",
      // no expirationDate
    });
    expect(r.status).toBe("not_purchased");
    if (r.status === "not_purchased") {
      expect(r.reason).toContain("Expiration date");
    }
  });
});

describe("grounding: every 'found' result has provenance", () => {
  it("basePriceId is always a positive integer", () => {
    const cases: PriceLookupRequest[] = [
      { category: "test_strips", productName: "Accu-Chek Aviva plus 100", reference: null, condition: "mint", expirationDate: utc(2027, 5) },
      { category: "test_strips", productName: "Accu-Chek Aviva plus 100", reference: null, condition: "ding", expirationDate: utc(2027, 5) },
      { category: "test_strips", productName: "Accu-Chek Aviva plus 100", reference: null, condition: "expired", expirationDate: utc(2026, 4) },
      { category: "libre", productName: "FREESTYLE LIBRE 3", reference: null, condition: "damaged", expirationDate: null },
      { category: "libre", productName: "FREESTYLE LIBRE 3", reference: null, condition: "short_date", expirationDate: null },
      { category: "dexcom_g6", productName: "DEXCOM SENSOR 3 PACK", reference: "OE", condition: "mint", expirationDate: utc(2027, 1) },
    ];

    for (const req of cases) {
      const filtered = allRows.filter(
        (r) => r.category === req.category && r.productName === req.productName && r.reference === req.reference,
      );
      const r = lookupPrice(req, filtered, rulesMap, TODAY);
      expect(r.status).toBe("found");
      if (r.status === "found") {
        expect(r.basePriceId).toBeGreaterThan(0);
        expect(Number.isInteger(r.basePriceId)).toBe(true);
      }
    }
  });

  it("ding results always carry an adjustmentRuleId", () => {
    const r = lookup({
      category: "test_strips",
      productName: "Accu-Chek Aviva plus 100",
      condition: "ding",
      expirationDate: utc(2027, 5),
    });
    expect(r.status).toBe("found");
    if (r.status === "found") {
      expect(r.adjustmentRuleId).toBeDefined();
      expect(r.adjustmentRuleId).toBeGreaterThan(0);
    }
  });
});

describe("grounding: the engine never produces a price from thin air", () => {
  it("found prices match actual DB row values", () => {
    // Pick a specific case and verify the finalPrice matches the row
    const req: PriceLookupRequest = {
      category: "dexcom_g7",
      productName: "DEXCOM SENSOR 1 PACK (Non-15 Day)",
      reference: "030",
      condition: "damaged",
      expirationDate: null,
    };
    const filtered = allRows.filter(
      (r) => r.category === req.category && r.productName === req.productName && r.reference === req.reference,
    );
    const result = lookupPrice(req, filtered, rulesMap, TODAY);
    expect(result.status).toBe("found");
    if (result.status === "found") {
      // Verify the price matches the actual row
      const sourceRow = filtered.find((r) => r.id === result.basePriceId);
      expect(sourceRow).toBeDefined();
      expect(result.finalPrice).toBe(sourceRow!.price);
    }
  });

  it("ding finalPrice = row price + rule delta (exact arithmetic)", () => {
    const req: PriceLookupRequest = {
      category: "dexcom_g6",
      productName: "DEXCOM SENSOR 3 PACK",
      reference: "OE",
      condition: "ding",
      expirationDate: utc(2026, 11, 15), // 11/2026 tier → $240
    };
    const filtered = allRows.filter(
      (r) => r.category === req.category && r.productName === req.productName && r.reference === req.reference,
    );
    const result = lookupPrice(req, filtered, rulesMap, TODAY);
    expect(result.status).toBe("found");
    if (result.status === "found") {
      const sourceRow = filtered.find((r) => r.id === result.basePriceId);
      const rule = rulesMap.get(sourceRow!.dingRuleKey!);
      expect(result.finalPrice).toBe(sourceRow!.price + rule!.deltaAmount);
      expect(result.finalPrice).toBe(230); // $240 − $10
    }
  });
});
