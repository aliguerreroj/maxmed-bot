import { describe, it, expect, beforeAll, beforeEach, vi, afterEach } from "vitest";
import ExcelJS from "exceljs";
import { parseTestStrips } from "../src/parsers/testStrips.js";
import { parseLibre } from "../src/parsers/libre.js";
import { parseDexcom } from "../src/parsers/dexcom.js";
import {
  mergePartial,
  SessionStore,
  handleSessionMessage,
  handleStartCommand,
  handleQuoteCommand,
  parseFollowUp,
  EMPTY_PARTIAL,
  type SessionDeps,
  type PartialItem,
} from "../src/bot/session.js";
import type { ExtractionResult, ExtractionItem } from "../src/bot/extraction.js";
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

function item(overrides: Partial<ExtractionItem>): ExtractionItem {
  return {
    category: null,
    productName: null,
    reference: null,
    condition: null,
    expirationDate: null,
    quantity: null,
    rawProductDescription: null,
    ...overrides,
  };
}

function makeDeps(extraction: ExtractionResult): SessionDeps {
  return {
    extract: async () => extraction,
    queryPrices: async (cat, name, ref) =>
      allRows.filter(
        (r) =>
          r.category === cat &&
          r.productName === name &&
          r.reference === ref,
      ),
    rules: rulesMap,
    today: TODAY,
  };
}

// ========== mergePartial ==========

describe("mergePartial", () => {
  it("incoming non-null overrides previous value", () => {
    const prev: PartialItem = {
      ...EMPTY_PARTIAL,
      category: "test_strips",
      productName: "Old Product",
    };
    const incoming = item({ quantity: 10 });
    const merged = mergePartial(prev, incoming);

    expect(merged.category).toBe("test_strips"); // kept
    expect(merged.productName).toBe("Old Product"); // kept
    expect(merged.quantity).toBe(10); // overridden
  });

  it("incoming null keeps previous value", () => {
    const prev: PartialItem = {
      ...EMPTY_PARTIAL,
      category: "test_strips",
      expirationDate: "2027-05-01",
    };
    const incoming = item({ condition: "mint" }); // expirationDate is null
    const merged = mergePartial(prev, incoming);

    expect(merged.expirationDate).toBe("2027-05-01"); // kept
    expect(merged.condition).toBe("mint"); // set
  });

  it("product switch clears previous fields", () => {
    const prev: PartialItem = {
      category: "test_strips",
      productName: "Accu-Chek Aviva plus 100",
      reference: null,
      condition: "mint",
      expirationDate: "2027-05-01",
      quantity: 10,
    };
    const incoming = item({
      category: "libre",
      productName: "FREESTYLE LIBRE 3",
    });
    const merged = mergePartial(prev, incoming);

    expect(merged.category).toBe("libre");
    expect(merged.productName).toBe("FREESTYLE LIBRE 3");
    // Previous fields should NOT carry over
    expect(merged.expirationDate).toBeNull();
    expect(merged.quantity).toBeNull();
    expect(merged.condition).toBeNull();
  });

  it("same product continues accumulating", () => {
    const prev: PartialItem = {
      ...EMPTY_PARTIAL,
      category: "test_strips",
      productName: "Accu-Chek Aviva plus 100",
    };
    const incoming = item({
      category: "test_strips",
      productName: "Accu-Chek Aviva plus 100",
      expirationDate: "2027-05-01",
    });
    const merged = mergePartial(prev, incoming);

    expect(merged.category).toBe("test_strips");
    expect(merged.productName).toBe("Accu-Chek Aviva plus 100");
    expect(merged.expirationDate).toBe("2027-05-01");
  });

  it("empty prev + full incoming = incoming", () => {
    const incoming = item({
      category: "libre",
      productName: "FREESTYLE LIBRE 3",
      condition: "damaged",
      quantity: 5,
    });
    const merged = mergePartial({ ...EMPTY_PARTIAL }, incoming);

    expect(merged.category).toBe("libre");
    expect(merged.productName).toBe("FREESTYLE LIBRE 3");
    expect(merged.condition).toBe("damaged");
    expect(merged.quantity).toBe(5);
  });

  it("null incoming identity preserves session (the follow-up case)", () => {
    const prev: PartialItem = {
      category: "test_strips",
      productName: "Accu-Chek Aviva plus 100",
      reference: null,
      condition: "mint",
      expirationDate: null,
      quantity: null,
    };
    // Follow-up: "exp May 2027, 10 boxes" → LLM returns null identity
    const incoming = item({
      category: null,
      productName: null,
      expirationDate: "2027-05-01",
      quantity: 10,
      condition: "mint",
    });
    const merged = mergePartial(prev, incoming);

    // Identity MUST be preserved from session
    expect(merged.category).toBe("test_strips");
    expect(merged.productName).toBe("Accu-Chek Aviva plus 100");
    // New fields filled in
    expect(merged.expirationDate).toBe("2027-05-01");
    expect(merged.quantity).toBe(10);
  });
});

// ========== session message flow ==========

describe("session: partial → follow-up → quote", () => {
  it("first message with partial info asks for missing fields", async () => {
    const store = new SessionStore();
    const deps = makeDeps({
      items: [item({ category: "test_strips", productName: "Accu-Chek Aviva plus 100" })],
      isGreeting: false,
    });

    const r = await handleSessionMessage(1, "test", store, deps);

    expect(r.text).toContain("expiration date");
    expect(r.shouldRouteToHuman).toBe(false);

    // Session should have the partial stored
    const session = store.get(1);
    expect(session.partial.category).toBe("test_strips");
    expect(session.partial.productName).toBe("Accu-Chek Aviva plus 100");
    expect(session.quotedItems.length).toBe(0);
  });

  it("follow-up with expiration completes the quote", async () => {
    const store = new SessionStore();

    // Step 1: partial info
    const deps1 = makeDeps({
      items: [item({ category: "test_strips", productName: "Accu-Chek Aviva plus 100" })],
      isGreeting: false,
    });
    await handleSessionMessage(1, "aviva 100", store, deps1);

    // Step 2: expiration date (merge completes the lookup)
    const deps2 = makeDeps({
      items: [item({ expirationDate: "2027-05-15", quantity: 10, condition: "mint" })],
      isGreeting: false,
    });
    const r = await handleSessionMessage(1, "exp may 2027, 10 boxes", store, deps2);

    expect(r.text).toContain("$60");
    expect(r.text).toContain("✅");

    const session = store.get(1);
    expect(session.quotedItems.length).toBe(1);
    expect(session.quotedItems[0]!.unitPrice).toBe(60);
    expect(session.quotedItems[0]!.totalPrice).toBe(600);
  });

  it("follow-up with ZERO items extracted still continues the session (not greeting)", async () => {
    const store = new SessionStore();

    // Step 1: product identified
    const deps1 = makeDeps({
      items: [item({ category: "test_strips", productName: "Accu-Chek Aviva plus 100" })],
      isGreeting: false,
    });
    await handleSessionMessage(1, "aviva 100", store, deps1);

    // Step 2: LLM returns EMPTY items (no product in message → 0 items)
    const deps2 = makeDeps({ items: [], isGreeting: false });
    const r = await handleSessionMessage(1, "exp May 2027", store, deps2);

    // Must NOT show the welcome greeting
    expect(r.text).not.toContain("MAXMED Distributors quote bot");
    // Should still know about the product and ask for what's missing
    expect(r.shouldRouteToHuman).toBe(false);
  });

  it("follow-up with isGreeting=true still continues the session when partial exists", async () => {
    const store = new SessionStore();

    // Step 1: product identified
    const deps1 = makeDeps({
      items: [item({ category: "test_strips", productName: "Accu-Chek Aviva plus 100" })],
      isGreeting: false,
    });
    await handleSessionMessage(1, "aviva 100", store, deps1);

    // Step 2: LLM misclassifies follow-up as greeting
    const deps2 = makeDeps({ items: [], isGreeting: true });
    const r = await handleSessionMessage(1, "they expire in May 2027", store, deps2);

    // Must NOT show the welcome greeting
    expect(r.text).not.toContain("MAXMED Distributors quote bot");
    expect(r.shouldRouteToHuman).toBe(false);
  });

  it("follow-up with null category/productName merges with session (not a product switch)", async () => {
    const store = new SessionStore();

    // Step 1: product identified
    const deps1 = makeDeps({
      items: [item({ category: "test_strips", productName: "Accu-Chek Aviva plus 100" })],
      isGreeting: false,
    });
    await handleSessionMessage(1, "aviva 100", store, deps1);

    // Step 2: extraction returns item with null identity but filled exp/qty
    const deps2 = makeDeps({
      items: [item({
        category: null,
        productName: null,
        expirationDate: "2027-05-15",
        quantity: 10,
        condition: "mint",
      })],
      isGreeting: false,
    });
    const r = await handleSessionMessage(1, "exp May 2027, 10 boxes", store, deps2);

    // Should complete the quote with merged data
    expect(r.text).toContain("$60");
    expect(r.text).toContain("✅");

    const session = store.get(1);
    expect(session.quotedItems.length).toBe(1);
    expect(session.quotedItems[0]!.unitPrice).toBe(60);
  });
});

describe("session: multi-item accumulation", () => {
  it("multiple successful quotes accumulate in the session", async () => {
    const store = new SessionStore();

    // Item 1
    const deps1 = makeDeps({
      items: [item({
        category: "test_strips",
        productName: "Accu-Chek Aviva plus 100",
        condition: "mint",
        expirationDate: "2027-05-15",
        quantity: 10,
      })],
      isGreeting: false,
    });
    await handleSessionMessage(1, "msg1", store, deps1);

    // Item 2
    const deps2 = makeDeps({
      items: [item({
        category: "libre",
        productName: "FREESTYLE LIBRE 3",
        condition: "damaged",
        quantity: 5,
      })],
      isGreeting: false,
    });
    const r2 = await handleSessionMessage(1, "msg2", store, deps2);

    const session = store.get(1);
    expect(session.quotedItems.length).toBe(2);
    expect(session.quotedItems[0]!.unitPrice).toBe(60);
    expect(session.quotedItems[1]!.unitPrice).toBe(27);

    // Response should mention the queue count
    expect(r2.text).toContain("2 item(s)");
  });
});

describe("session: multi-item in single message", () => {
  it("processes multiple items from one extraction", async () => {
    const store = new SessionStore();
    const deps = makeDeps({
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
    });

    await handleSessionMessage(1, "msg", store, deps);
    const session = store.get(1);
    expect(session.quotedItems.length).toBe(2);
  });
});

// ========== /quote command ==========

describe("/quote command", () => {
  it("generates PDF and clears session", async () => {
    const store = new SessionStore();
    const session = store.get(1);
    session.quotedItems.push({
      productName: "Accu-Chek Aviva plus 100",
      reference: null,
      condition: "mint",
      quantity: 10,
      unitPrice: 60,
      totalPrice: 600,
      basePriceId: 1,
    });

    const r = await handleQuoteCommand(1, store);

    expect(r.text).toContain("MAXMED");
    expect(r.text).toContain("$600");
    expect(r.pdfBuffer).not.toBeNull();
    expect(r.pdfBuffer!.subarray(0, 4).toString()).toBe("%PDF");

    // Session should be cleared
    expect(store.has(1)).toBe(false);
  });

  it("empty quote returns helpful message, no PDF", async () => {
    const store = new SessionStore();
    const r = await handleQuoteCommand(1, store);

    expect(r.text).toContain("don't have any items");
    expect(r.pdfBuffer).toBeNull();
  });
});

// ========== /start command ==========

describe("/start command", () => {
  it("returns intro and clears any existing session", () => {
    const store = new SessionStore();
    const session = store.get(1);
    session.quotedItems.push({
      productName: "test",
      reference: null,
      condition: "mint",
      quantity: 1,
      unitPrice: 10,
      totalPrice: 10,
      basePriceId: 1,
    });

    const r = handleStartCommand(1, store);

    expect(r.text).toContain("MAXMED");
    expect(store.has(1)).toBe(false);
  });
});

// ========== greeting with queue ==========

describe("greeting with queued items", () => {
  it("reminds about /quote when items are queued", async () => {
    const store = new SessionStore();
    const session = store.get(1);
    session.quotedItems.push({
      productName: "test",
      reference: null,
      condition: "mint",
      quantity: 1,
      unitPrice: 10,
      totalPrice: 10,
      basePriceId: 1,
    });

    const deps = makeDeps({ items: [], isGreeting: true });
    const r = await handleSessionMessage(1, "hi", store, deps);

    expect(r.text).toContain("/quote");
    expect(r.text).toContain("1 item(s)");
  });
});

// ========== unrecognized products → route to human ==========

describe("unrecognized product: LLM extracts item with rawProductDescription", () => {
  it("Omnipod Dash pods → routes to human, not ask-for-product", async () => {
    const store = new SessionStore();
    const deps = makeDeps({
      items: [item({
        category: null,
        productName: null,
        rawProductDescription: "Omnipod Dash pods",
        condition: "mint",
        quantity: 3,
      })],
      isGreeting: false,
    });

    const r = await handleSessionMessage(1, "I have Omnipod Dash pods, 3 boxes, sealed", store, deps);

    expect(r.text).toContain("Omnipod Dash pods");
    expect(r.text).toContain("price list");
    expect(r.shouldRouteToHuman).toBe(true);
    // Should NOT ask for product name
    expect(r.text).not.toContain("which product");
  });

  it("clears partial state so next message starts fresh", async () => {
    const store = new SessionStore();

    // Set up an active partial first
    const session = store.get(1);
    session.partial = {
      ...EMPTY_PARTIAL,
      category: "test_strips",
      productName: "Accu-Chek Aviva plus 100",
    };

    // Now seller switches to an unknown product
    const deps = makeDeps({
      items: [item({
        category: null,
        productName: null,
        rawProductDescription: "Omnipod Dash pods",
        condition: "mint",
      })],
      isGreeting: false,
    });

    const r = await handleSessionMessage(1, "actually I have Omnipod Dash", store, deps);

    expect(r.shouldRouteToHuman).toBe(true);
    // Partial should be cleared
    const updated = store.get(1);
    expect(updated.partial.category).toBeNull();
    expect(updated.partial.productName).toBeNull();
  });
});

describe("unrecognized product: LLM returns 0 items (safety net)", () => {
  it("Medtronic pump supplies → routes to human, not greeting", async () => {
    const store = new SessionStore();
    const deps = makeDeps({
      items: [],
      isGreeting: false, // LLM knows it's not a greeting but can't extract
    });

    const r = await handleSessionMessage(1, "I have some Medtronic pump supplies", store, deps);

    expect(r.text).toContain("team member");
    expect(r.shouldRouteToHuman).toBe(true);
    // Must NOT show the welcome greeting
    expect(r.text).not.toContain("MAXMED Distributors quote bot");
  });
});

// ========== parseFollowUp (regex fallback) ==========

describe("parseFollowUp", () => {
  it("extracts English month + year", () => {
    const r = parseFollowUp("exp May 2027");
    expect(r.expirationDate).toBe("2027-05-01");
  });

  it("extracts Spanish month + year", () => {
    const r = parseFollowUp("vencen mayo 2027");
    expect(r.expirationDate).toBe("2027-05-01");
  });

  it("extracts M/YYYY format", () => {
    const r = parseFollowUp("expires 12/2026");
    expect(r.expirationDate).toBe("2026-12-01");
  });

  it("extracts M/YY format", () => {
    const r = parseFollowUp("exp 5/27");
    expect(r.expirationDate).toBe("2027-05-01");
  });

  it("extracts quantity with unit", () => {
    const r = parseFollowUp("I have 10 boxes");
    expect(r.quantity).toBe(10);
  });

  it("extracts quantity in Spanish", () => {
    const r = parseFollowUp("tengo 5 cajas");
    expect(r.quantity).toBe(5);
  });

  it("extracts condition: sealed", () => {
    expect(parseFollowUp("all sealed").condition).toBe("mint");
    expect(parseFollowUp("selladas").condition).toBe("mint");
  });

  it("extracts condition: ding", () => {
    expect(parseFollowUp("they are dinged").condition).toBe("ding");
  });

  it("extracts condition: damaged", () => {
    expect(parseFollowUp("están dañadas").condition).toBe("damaged");
  });

  it("extracts multiple fields from one message", () => {
    const r = parseFollowUp("exp May 2027, 10 boxes, sealed");
    expect(r.expirationDate).toBe("2027-05-01");
    expect(r.quantity).toBe(10);
    expect(r.condition).toBe("mint");
  });

  it("returns all null when nothing matches", () => {
    const r = parseFollowUp("hello there");
    expect(r.expirationDate).toBeNull();
    expect(r.quantity).toBeNull();
    expect(r.condition).toBeNull();
  });
});

// ========== regex fallback integration ==========

describe("session: regex fallback when LLM returns 0 items", () => {
  it("parses date+qty from follow-up and completes the quote", async () => {
    const store = new SessionStore();

    // Step 1: product identified via LLM extraction
    const deps1 = makeDeps({
      items: [item({ category: "test_strips", productName: "Accu-Chek Aviva plus 100" })],
      isGreeting: false,
    });
    await handleSessionMessage(1, "I have Aviva 100", store, deps1);

    // Step 2: LLM returns ZERO items for "exp May 2027, 10 boxes"
    // but the regex fallback extracts the date and quantity
    const deps2 = makeDeps({ items: [], isGreeting: false });
    const r = await handleSessionMessage(1, "exp May 2027, 10 boxes, sealed", store, deps2);

    // Should complete the quote via regex fallback + session merge
    expect(r.text).toContain("$60");
    expect(r.text).toContain("✅");

    const session = store.get(1);
    expect(session.quotedItems.length).toBe(1);
    expect(session.quotedItems[0]!.unitPrice).toBe(60);
    expect(session.quotedItems[0]!.totalPrice).toBe(600);
  });

  it("Spanish follow-up works through regex fallback", async () => {
    const store = new SessionStore();

    const deps1 = makeDeps({
      items: [item({ category: "test_strips", productName: "Accu-Chek Aviva plus 100" })],
      isGreeting: false,
    });
    await handleSessionMessage(1, "tengo Aviva 100", store, deps1);

    const deps2 = makeDeps({ items: [], isGreeting: false });
    const r = await handleSessionMessage(1, "vencen mayo 2027, 10 cajas, selladas", store, deps2);

    expect(r.text).toContain("$60");
    expect(r.text).toContain("✅");
  });
});

// ========== auto-clear ==========

describe("auto-clear after TTL", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("session is cleared after TTL expires", () => {
    const store = new SessionStore(5000); // 5 seconds for test
    store.get(1); // create session

    expect(store.has(1)).toBe(true);

    vi.advanceTimersByTime(4999);
    expect(store.has(1)).toBe(true);

    vi.advanceTimersByTime(2);
    expect(store.has(1)).toBe(false);
  });

  it("activity resets the TTL", () => {
    const store = new SessionStore(5000);
    store.get(1);

    vi.advanceTimersByTime(4000);
    store.get(1); // activity resets timer

    vi.advanceTimersByTime(4000);
    expect(store.has(1)).toBe(true); // still alive (4s since reset)

    vi.advanceTimersByTime(1001);
    expect(store.has(1)).toBe(false); // 5s since reset → cleared
  });
});
