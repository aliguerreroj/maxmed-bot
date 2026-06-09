/**
 * Message handler: the pipeline that connects the two LLM calls
 * through the deterministic price engine.
 *
 * Telegram → extract (LLM) → lookup (engine) → phrase (LLM) → reply
 *
 * Fully injectable: no global state, no direct DB or API access.
 * This makes it testable with mocked dependencies.
 */

import { lookupPrice } from "../engine/lookup.js";
import { buildQuoteData, generateQuotePDF } from "./quote.js";
import type {
  PriceLookupRequest,
  PriceRow,
  DingRule,
  RequestCondition,
} from "../engine/types.js";
import type { ExtractionResult, ExtractionItem } from "./extraction.js";
import type { PhraseInput, PhraseItem } from "./phrasing.js";

// ---- dependency injection types ----

export interface HandlerDeps {
  extract: (message: string) => Promise<ExtractionResult>;
  queryPrices: (
    category: string,
    productName: string,
    reference: string | null,
  ) => Promise<PriceRow[]>;
  rules: Map<string, DingRule>;
  phrase: (input: PhraseInput) => Promise<string>;
  today?: Date;
}

export interface BotResponse {
  text: string;
  shouldRouteToHuman: boolean;
  /** Structured quote data for PDF generation. */
  quoteItems: QuoteItem[];
  /** PDF quote buffer, attached when items are quoted. */
  pdfBuffer: Buffer | null;
}

export interface QuoteItem {
  productName: string;
  reference: string | null;
  condition: string;
  quantity: number | null;
  unitPrice: number;
  totalPrice: number | null;
  basePriceId: number;
  adjustmentRuleId?: number;
}

const VALID_CONDITIONS = new Set<string>([
  "mint",
  "ding",
  "damaged",
  "short_date",
  "expired",
]);

const GREETING_RESPONSE =
  "Hi! I'm the MAXMED Distributors quote bot. We buy diabetic supplies — " +
  "test strips, Dexcom sensors, Freestyle Libre sensors, and more.\n\n" +
  "Tell me what you have (product, quantity, expiration date, and condition) " +
  "and I'll give you a quote right away!";

function routeToHuman(text: string): BotResponse {
  return { text, shouldRouteToHuman: true, quoteItems: [], pdfBuffer: null };
}

/**
 * Handle a single incoming message end-to-end.
 */
export async function handleMessage(
  message: string,
  deps: HandlerDeps,
): Promise<BotResponse> {
  const today = deps.today ?? new Date();

  // ---- step 1: extraction ----
  let extraction: ExtractionResult;
  try {
    extraction = await deps.extract(message);
  } catch (err) {
    console.error("Extraction failed:", err);
    return routeToHuman(
      "I wasn't able to process your message. Let me connect you with a team member who can help.",
    );
  }

  // Greeting / non-supply message
  if (extraction.isGreeting || extraction.items.length === 0) {
    return {
      text: GREETING_RESPONSE,
      shouldRouteToHuman: false,
      quoteItems: [],
      pdfBuffer: null,
    };
  }

  // ---- step 2: engine lookup for each extracted item ----
  const quotedItems: PhraseItem[] = [];
  const quoteItems: QuoteItem[] = [];
  const notPurchased: PhraseInput["notPurchasedItems"] = [];
  const notFound: PhraseInput["notFoundItems"] = [];
  const expiredTooOld: PhraseInput["expiredTooOldItems"] = [];
  let needsHuman = false;

  for (const item of extraction.items) {
    const result = await processItem(item, deps, today);

    switch (result.kind) {
      case "quoted":
        quotedItems.push(result.phraseItem);
        quoteItems.push(result.quoteItem);
        break;
      case "not_purchased":
        notPurchased.push(result.entry);
        break;
      case "not_found":
        notFound.push(result.entry);
        needsHuman = true;
        break;
      case "expired_too_old":
        expiredTooOld.push(result.entry);
        break;
      case "incomplete":
        notFound.push({
          description: result.description,
        });
        needsHuman = true;
        break;
    }
  }

  // ---- step 3: phrasing ----
  let text: string;
  try {
    text = await deps.phrase({
      quotedItems,
      notPurchasedItems: notPurchased,
      notFoundItems: notFound,
      expiredTooOldItems: expiredTooOld,
    });
  } catch (err) {
    console.error("Phrasing failed:", err);
    // Fall back to a structured response rather than failing entirely.
    text = buildFallbackResponse(quotedItems, notPurchased, notFound, expiredTooOld);
  }

  // ---- step 4: generate PDF if items were quoted ----
  let pdfBuffer: Buffer | null = null;
  if (quoteItems.length > 0) {
    try {
      const quoteData = buildQuoteData(quoteItems);
      pdfBuffer = await generateQuotePDF(quoteData);
    } catch (err) {
      console.error("PDF generation failed:", err);
      // Non-fatal: the text reply still goes out, just without the PDF.
    }
  }

  return { text, shouldRouteToHuman: needsHuman, quoteItems, pdfBuffer };
}

// ---- per-item processing ----

type ProcessResult =
  | { kind: "quoted"; phraseItem: PhraseItem; quoteItem: QuoteItem }
  | { kind: "not_purchased"; entry: { description: string; reason: string } }
  | { kind: "not_found"; entry: { description: string } }
  | { kind: "expired_too_old"; entry: { description: string; reason: string } }
  | { kind: "incomplete"; description: string };

async function processItem(
  item: ExtractionItem,
  deps: HandlerDeps,
  today: Date,
): Promise<ProcessResult> {
  const desc = itemDescription(item);

  // Validate required fields
  if (!item.category || !item.productName) {
    return { kind: "incomplete", description: desc };
  }

  if (!item.condition || !VALID_CONDITIONS.has(item.condition)) {
    return { kind: "incomplete", description: desc };
  }

  // Parse expiration date
  let expDate: Date | null = null;
  if (item.expirationDate) {
    expDate = new Date(item.expirationDate + "T00:00:00Z");
    if (Number.isNaN(expDate.getTime())) {
      return { kind: "incomplete", description: desc };
    }
  }

  // Query DB for this product
  const rows = await deps.queryPrices(
    item.category,
    item.productName,
    item.reference ?? null,
  );

  // Run the engine
  const request: PriceLookupRequest = {
    category: item.category,
    productName: item.productName,
    reference: item.reference ?? null,
    condition: item.condition as RequestCondition,
    expirationDate: expDate,
  };

  const result = lookupPrice(request, rows, deps.rules, today);

  switch (result.status) {
    case "found": {
      const qty = item.quantity ?? null;
      const totalPrice = qty !== null ? result.finalPrice * qty : null;

      return {
        kind: "quoted",
        phraseItem: {
          productName: item.productName,
          reference: item.reference ?? null,
          condition: item.condition,
          quantity: qty,
          unitPrice: result.finalPrice,
          totalPrice,
          breakdown: result.breakdown,
        },
        quoteItem: {
          productName: item.productName,
          reference: item.reference ?? null,
          condition: item.condition,
          quantity: qty,
          unitPrice: result.finalPrice,
          totalPrice,
          basePriceId: result.basePriceId,
          adjustmentRuleId: result.adjustmentRuleId,
        },
      };
    }

    case "not_purchased":
      return { kind: "not_purchased", entry: { description: desc, reason: result.reason } };

    case "not_found":
      return { kind: "not_found", entry: { description: desc } };

    case "expired_too_old":
      return { kind: "expired_too_old", entry: { description: desc, reason: result.reason } };
  }
}

function itemDescription(item: ExtractionItem): string {
  const parts = [item.productName ?? "unknown product"];
  if (item.reference) parts.push(`ref: ${item.reference}`);
  if (item.condition) parts.push(item.condition);
  if (item.expirationDate) parts.push(`exp: ${item.expirationDate}`);
  if (item.quantity) parts.push(`qty: ${item.quantity}`);
  return parts.join(", ");
}

/** Structured fallback when phrasing LLM fails. */
function buildFallbackResponse(
  quoted: PhraseItem[],
  notPurchased: PhraseInput["notPurchasedItems"],
  notFound: PhraseInput["notFoundItems"],
  expiredTooOld: PhraseInput["expiredTooOldItems"],
): string {
  const lines: string[] = ["Here are the results for your items:"];

  for (const item of quoted) {
    const ref = item.reference ? ` (${item.reference})` : "";
    const total = item.totalPrice !== null ? `, total $${item.totalPrice}` : "";
    lines.push(
      `• ${item.productName}${ref}: $${item.unitPrice}/unit${total}`,
    );
  }

  for (const item of notPurchased) {
    lines.push(`• ${item.description}: not currently purchasing`);
  }

  for (const item of notFound) {
    lines.push(
      `• ${item.description}: let me connect you with a team member`,
    );
  }

  for (const item of expiredTooOld) {
    lines.push(`• ${item.description}: unfortunately too old to accept`);
  }

  return lines.join("\n");
}
