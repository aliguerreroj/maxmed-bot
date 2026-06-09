/**
 * Handler pipeline tests.
 *
 * These mock the two LLM calls (extraction + phrasing) and use real
 * parsed price data for the engine. This proves:
 *   - The handler correctly wires extraction → engine → phrasing.
 *   - Quantity multiplication is exact.
 *   - Null extraction fields route to human.
 *   - Engine "not_found" and "not_purchased" propagate correctly.
 *   - Greetings get the intro message.
 *   - Extraction failures route to human gracefully.
 */

import { describe, it, expect, beforeAll } from "vitest";
import ExcelJS from "exceljs";
import { parseTestStrips } from "../src/parsers/testStrips.js";
import { parseLibre } from "../src/parsers/libre.js";
import { parseDexcom } from "../src/parsers/dexcom.js";
import { handleMessage, type HandlerDeps } from "../src/bot/handler.js";
import type { ExtractionResult, ExtractionItem } from "../src/bot/extraction.js";
import type { PhraseInput } from "../src/bot/phrasing.js";
import type { PriceRow, DingRule } from "../src/engine/types.js";

const TODAY = new Date(Date.UTC(2026, 5, 8));

let allRows: PriceRow[];
let rulesMap: Map<string, DingRule>;

beforeAll(async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile("data/price-sheet.xlsx");

  const ts = parseTestStrips(wb.getWorksheet("Test Strips")!);
  const lib = parseLibre(wb.getWorksheet("Libres")!);
  const dex = parseDexcom(wb.getWorksheet("G6G7")!);

  const allParsed = [...ts.prices, ...lib.prices, ...dex.prices];
  allRows = allParsed.map((p, i) => ({
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

  const allRules = [...ts.rules, ...lib.rules, ...dex.rules];
  rulesMap = new Map(
    allRules.map((r, i) => [
      r.scopeKey,
      { id: i + 1, scopeKey: r.scopeKey, deltaAmount: Number(r.deltaAmount) },
    ]),
  );
});

/** Build test deps with a mock extraction result and a phrasing spy. */
function makeDeps(
  extractionResult: ExtractionResult,
  phraseCapture?: { input?: PhraseInput },
): HandlerDeps {
  return {
    extract: async () => extractionResult,
    queryPrices: async (cat, name, ref) =>
      allRows.filter(
        (r) => r.category === cat && r.productName === name && r.reference === ref,
      ),
    rules: rulesMap,
    phrase: async (input) => {
      if (phraseCapture) phraseCapture.input = input;
      // Return a simple mock phrasing
      const items = input.quotedItems
        .map((i) => `${i.productName}: $${i.unitPrice}`)
        .join(", ");
      return items || "No items to quote.";
    },
    today: TODAY,
  };
}

function item(overrides: Partial<ExtractionItem>): ExtractionItem {
  return {
    category: null,
    productName: null,
    reference: null,
    condition: null,
    expirationDate: null,
    quantity: null,
    ...overrides,
  };
}

// ========== happy path ==========

describe("happy path: single item", () => {
  it("Aviva 100 mint → found at $60, phrasing receives exact price", async () => {
    const capture: { input?: PhraseInput } = {};
    const r = await handleMessage("test", makeDeps(
      {
        items: [item({
          category: "test_strips",
          productName: "Accu-Chek Aviva plus 100",
          condition: "mint",
          expirationDate: "2027-05-15",
          quantity: 10,
        })],
        isGreeting: false,
      },
      capture,
    ));

    expect(r.shouldRouteToHuman).toBe(false);
    expect(r.quoteItems.length).toBe(1);
    expect(r.quoteItems[0]!.unitPrice).toBe(60);
    expect(r.quoteItems[0]!.totalPrice).toBe(600);
    expect(r.quoteItems[0]!.basePriceId).toBeGreaterThan(0);

    // Verify the phrasing LLM received the exact price
    expect(capture.input!.quotedItems[0]!.unitPrice).toBe(60);
    expect(capture.input!.quotedItems[0]!.totalPrice).toBe(600);
  });
});

describe("happy path: ding with provenance", () => {
  it("ding result includes both basePriceId and adjustmentRuleId", async () => {
    const r = await handleMessage("test", makeDeps({
      items: [item({
        category: "test_strips",
        productName: "Accu-Chek Aviva plus 100",
        condition: "ding",
        expirationDate: "2027-05-15",
        quantity: 5,
      })],
      isGreeting: false,
    }));

    expect(r.quoteItems[0]!.unitPrice).toBe(57); // $60 − $3
    expect(r.quoteItems[0]!.totalPrice).toBe(285);
    expect(r.quoteItems[0]!.basePriceId).toBeGreaterThan(0);
    expect(r.quoteItems[0]!.adjustmentRuleId).toBeGreaterThan(0);
  });
});

describe("happy path: quantity null → per-unit only", () => {
  it("totalPrice is null when quantity not provided", async () => {
    const r = await handleMessage("test", makeDeps({
      items: [item({
        category: "libre",
        productName: "FREESTYLE LIBRE 3",
        condition: "damaged",
      })],
      isGreeting: false,
    }));

    expect(r.quoteItems[0]!.unitPrice).toBe(27);
    expect(r.quoteItems[0]!.totalPrice).toBeNull();
    expect(r.quoteItems[0]!.quantity).toBeNull();
  });
});

describe("happy path: multiple items", () => {
  it("processes each item independently", async () => {
    const r = await handleMessage("test", makeDeps({
      items: [
        item({
          category: "test_strips",
          productName: "Accu-Chek Aviva plus 100",
          condition: "mint",
          expirationDate: "2027-05-15",
          quantity: 5,
        }),
        item({
          category: "libre",
          productName: "FREESTYLE LIBRE 3",
          condition: "damaged",
          quantity: 3,
        }),
      ],
      isGreeting: false,
    }));

    expect(r.quoteItems.length).toBe(2);
    expect(r.quoteItems[0]!.unitPrice).toBe(60);
    expect(r.quoteItems[0]!.totalPrice).toBe(300);
    expect(r.quoteItems[1]!.unitPrice).toBe(27);
    expect(r.quoteItems[1]!.totalPrice).toBe(81);
  });
});

// ========== routing to human ==========

describe("null extraction fields → route to human", () => {
  it("null productName → shouldRouteToHuman", async () => {
    const r = await handleMessage("test", makeDeps({
      items: [item({
        category: "test_strips",
        productName: null,
        condition: "mint",
        expirationDate: "2027-05-15",
      })],
      isGreeting: false,
    }));

    expect(r.shouldRouteToHuman).toBe(true);
    expect(r.quoteItems.length).toBe(0);
  });

  it("null category → shouldRouteToHuman", async () => {
    const r = await handleMessage("test", makeDeps({
      items: [item({
        category: null,
        productName: "Accu-Chek Aviva plus 100",
        condition: "mint",
      })],
      isGreeting: false,
    }));

    expect(r.shouldRouteToHuman).toBe(true);
  });

  it("null condition → shouldRouteToHuman", async () => {
    const r = await handleMessage("test", makeDeps({
      items: [item({
        category: "test_strips",
        productName: "Accu-Chek Aviva plus 100",
        condition: null,
        expirationDate: "2027-05-15",
      })],
      isGreeting: false,
    }));

    expect(r.shouldRouteToHuman).toBe(true);
  });
});

describe("unknown product → route to human", () => {
  it("product not in DB → shouldRouteToHuman", async () => {
    const r = await handleMessage("test", makeDeps({
      items: [item({
        category: "test_strips",
        productName: "Nonexistent Widget 9000",
        condition: "mint",
        expirationDate: "2027-05-15",
      })],
      isGreeting: false,
    }));

    expect(r.shouldRouteToHuman).toBe(true);
    expect(r.quoteItems.length).toBe(0);
  });
});

describe("not_purchased → no human routing, informational", () => {
  it("known product, unavailable condition → not routed to human", async () => {
    const r = await handleMessage("test", makeDeps({
      items: [item({
        category: "test_strips",
        productName: "Accu-Chek Aviva plus 100",
        condition: "damaged",
      })],
      isGreeting: false,
    }));

    expect(r.shouldRouteToHuman).toBe(false);
    expect(r.quoteItems.length).toBe(0);
  });
});

// ========== greetings ==========

describe("greeting handling", () => {
  it("isGreeting → intro message, no human routing", async () => {
    const r = await handleMessage("test", makeDeps({
      items: [],
      isGreeting: true,
    }));

    expect(r.text).toContain("MAXMED");
    expect(r.shouldRouteToHuman).toBe(false);
    expect(r.quoteItems.length).toBe(0);
  });
});

// ========== error handling ==========

describe("extraction failure", () => {
  it("extraction throws → graceful route to human", async () => {
    const deps: HandlerDeps = {
      extract: async () => { throw new Error("LLM timeout"); },
      queryPrices: async () => [],
      rules: rulesMap,
      phrase: async () => "mock",
      today: TODAY,
    };

    const r = await handleMessage("test", deps);
    expect(r.shouldRouteToHuman).toBe(true);
    expect(r.text).toContain("team member");
  });
});

// ========== PDF generation ==========

describe("PDF quote generation", () => {
  it("generates a PDF buffer when items are quoted", async () => {
    const r = await handleMessage("test", makeDeps({
      items: [item({
        category: "test_strips",
        productName: "Accu-Chek Aviva plus 100",
        condition: "mint",
        expirationDate: "2027-05-15",
        quantity: 10,
      })],
      isGreeting: false,
    }));

    expect(r.pdfBuffer).not.toBeNull();
    expect(r.pdfBuffer!.length).toBeGreaterThan(100);
    // Valid PDF starts with %PDF
    expect(r.pdfBuffer!.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("no PDF for greetings", async () => {
    const r = await handleMessage("test", makeDeps({
      items: [],
      isGreeting: true,
    }));

    expect(r.pdfBuffer).toBeNull();
  });

  it("no PDF when all items are not_found", async () => {
    const r = await handleMessage("test", makeDeps({
      items: [item({
        category: "test_strips",
        productName: "Nonexistent Widget",
        condition: "mint",
        expirationDate: "2027-05-15",
      })],
      isGreeting: false,
    }));

    expect(r.pdfBuffer).toBeNull();
  });
});

describe("mixed: one found, one not_found", () => {
  it("quotes the found item, routes the unknown to human", async () => {
    const r = await handleMessage("test", makeDeps({
      items: [
        item({
          category: "libre",
          productName: "FREESTYLE LIBRE 3",
          condition: "mint",
          expirationDate: "2026-10-01",
          quantity: 2,
        }),
        item({
          category: "test_strips",
          productName: "Unknown Strip Brand",
          condition: "mint",
          expirationDate: "2027-05-15",
        }),
      ],
      isGreeting: false,
    }));

    expect(r.quoteItems.length).toBe(1);
    expect(r.quoteItems[0]!.unitPrice).toBe(55);
    expect(r.shouldRouteToHuman).toBe(true); // because of the unknown item
  });
});
