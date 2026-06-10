/**
 * Conversation session management.
 *
 * In-memory Map<chatId, Session> stores partial extraction fields and
 * accumulated quote items per chat. Each incoming message is extracted,
 * merged with the session's partial state, and then looked up in the engine.
 *
 * Design choices:
 *   - Per-item responses are structured text (no phrasing LLM call) for speed
 *     and cost. The phrasing LLM is only invoked for the final /quote summary.
 *   - The engine is called directly (not through handleMessage) so the
 *     existing handler module and its 15 tests stay untouched.
 *   - Auto-clear after TTL via setTimeout per session.
 */

import { lookupPrice } from "../engine/lookup.js";
import type {
  PriceLookupRequest,
  PriceRow,
  DingRule,
  RequestCondition,
} from "../engine/types.js";
import type { ExtractionResult, ExtractionItem } from "./extraction.js";
import type { QuoteItem } from "./handler.js";
import { buildQuoteData, generateQuotePDF } from "./quote.js";

// ---- partial item (session state) ----

export interface PartialItem {
  category: string | null;
  productName: string | null;
  reference: string | null;
  condition: string | null;
  expirationDate: string | null;
  quantity: number | null;
}

export const EMPTY_PARTIAL: PartialItem = {
  category: null,
  productName: null,
  reference: null,
  condition: null,
  expirationDate: null,
  quantity: null,
};

// ---- session ----

export interface Session {
  partial: PartialItem;
  quotedItems: QuoteItem[];
  lastActivity: number;
  timeoutId?: ReturnType<typeof setTimeout>;
}

// ---- session store ----

export class SessionStore {
  private sessions = new Map<number, Session>();
  private ttlMs: number;

  constructor(ttlMs: number = 10 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  get(chatId: number): Session {
    let session = this.sessions.get(chatId);
    if (!session) {
      session = {
        partial: { ...EMPTY_PARTIAL },
        quotedItems: [],
        lastActivity: Date.now(),
      };
      this.sessions.set(chatId, session);
    }
    this.touch(chatId, session);
    return session;
  }

  getIfExists(chatId: number): Session | undefined {
    const session = this.sessions.get(chatId);
    if (session) this.touch(chatId, session);
    return session;
  }

  clear(chatId: number): void {
    const session = this.sessions.get(chatId);
    if (session?.timeoutId) clearTimeout(session.timeoutId);
    this.sessions.delete(chatId);
  }

  /** Visible for testing. */
  has(chatId: number): boolean {
    return this.sessions.has(chatId);
  }

  private touch(chatId: number, session: Session): void {
    if (session.timeoutId) clearTimeout(session.timeoutId);
    session.lastActivity = Date.now();
    session.timeoutId = setTimeout(() => {
      this.sessions.delete(chatId);
    }, this.ttlMs);
  }
}

// ---- merge ----

/**
 * Merge an incoming extraction item into the session's partial state.
 * Non-null incoming fields override; null incoming fields keep the previous value.
 *
 * Product switch detection: ONLY when an incoming field is explicitly non-null
 * AND different from the session. If incoming category/productName are null,
 * the session values are always preserved — that's the whole point of the merge.
 */
export function mergePartial(
  prev: PartialItem,
  incoming: ExtractionItem,
): PartialItem {
  // A product switch requires the incoming side to POSITIVELY identify a
  // different product. Null incoming fields mean "not mentioned" — they
  // must never trigger a switch.
  const incomingHasCategory =
    incoming.category !== null && incoming.category !== undefined;
  const incomingHasName =
    incoming.productName !== null && incoming.productName !== undefined;

  const switchedCategory =
    incomingHasCategory &&
    prev.category !== null &&
    incoming.category !== prev.category;
  const switchedName =
    incomingHasName &&
    prev.productName !== null &&
    incoming.productName !== prev.productName;

  const base = switchedCategory || switchedName ? EMPTY_PARTIAL : prev;

  return {
    category: incoming.category ?? base.category,
    productName: incoming.productName ?? base.productName,
    reference: incoming.reference ?? base.reference,
    condition: incoming.condition ?? base.condition,
    expirationDate: incoming.expirationDate ?? base.expirationDate,
    quantity: incoming.quantity ?? base.quantity,
  };
}

// ---- dependencies (subset of HandlerDeps, no phrasing LLM) ----

export interface SessionDeps {
  extract: (message: string) => Promise<ExtractionResult>;
  queryPrices: (
    category: string,
    productName: string,
    reference: string | null,
  ) => Promise<PriceRow[]>;
  rules: Map<string, DingRule>;
  today?: Date;
}

// ---- response types ----

export interface SessionResponse {
  text: string;
  shouldRouteToHuman: boolean;
  pdfBuffer: Buffer | null;
}

// ---- intro text ----

const INTRO =
  "Hi! I'm the MAXMED Distributors quote bot. We buy diabetic supplies — " +
  "test strips, Dexcom sensors, Freestyle Libre sensors, and more.\n\n" +
  "Tell me what you have — product name, quantity, expiration date, and " +
  "condition — and I'll quote you a price right away. You can add multiple " +
  "items, then send /quote for a PDF with your complete quote.";

// ---- /start ----

export function handleStartCommand(
  chatId: number,
  store: SessionStore,
): SessionResponse {
  store.clear(chatId);
  return { text: INTRO, shouldRouteToHuman: false, pdfBuffer: null };
}

// ---- /quote ----

export async function handleQuoteCommand(
  chatId: number,
  store: SessionStore,
): Promise<SessionResponse> {
  const session = store.getIfExists(chatId);

  if (!session || session.quotedItems.length === 0) {
    return {
      text: "You don't have any items in your quote yet. Tell me about the supplies you'd like to sell!",
      shouldRouteToHuman: false,
      pdfBuffer: null,
    };
  }

  const quoteData = buildQuoteData(session.quotedItems);

  let pdfBuffer: Buffer | null = null;
  try {
    pdfBuffer = await generateQuotePDF(quoteData);
  } catch (err) {
    console.error("PDF generation failed:", err);
  }

  // Build summary text
  const lines = session.quotedItems.map(formatItemLine);
  let grandTotal: number | null = 0;
  for (const item of session.quotedItems) {
    if (item.totalPrice === null) {
      grandTotal = null;
      break;
    }
    grandTotal! += item.totalPrice;
  }

  const totalLine =
    grandTotal !== null ? `\n\nGrand total: $${grandTotal}` : "";
  const text =
    `Here's your complete quote (${quoteData.quoteNumber}):\n\n` +
    lines.map((l) => `• ${l}`).join("\n") +
    totalLine +
    "\n\nThank you for choosing MAXMED Distributors!";

  store.clear(chatId);

  return { text, shouldRouteToHuman: false, pdfBuffer };
}

// ---- main message handler ----

export async function handleSessionMessage(
  chatId: number,
  message: string,
  store: SessionStore,
  deps: SessionDeps,
): Promise<SessionResponse> {
  const session = store.get(chatId);
  const today = deps.today ?? new Date();

  // ---- closing phrase → auto-trigger /quote (skips LLM call) ----
  if (session.quotedItems.length > 0 && isClosingPhrase(message)) {
    return handleQuoteCommand(chatId, store);
  }

  // ---- extraction ----
  let extraction: ExtractionResult;
  try {
    extraction = await deps.extract(message);
  } catch (err) {
    console.error("Extraction failed:", err);
    return {
      text: "I wasn't able to process that. Let me connect you with a team member.",
      shouldRouteToHuman: true,
      pdfBuffer: null,
    };
  }

  // ---- greeting / non-supply message ----
  const hasActivePartial =
    session.partial.category != null || session.partial.productName != null;

  if (extraction.isGreeting || extraction.items.length === 0) {
    if (hasActivePartial) {
      // Session has partial data — this is likely a follow-up, not a greeting.
      // The LLM extraction found no items (no product mentioned), but the
      // message may contain fields like dates and quantities. Parse them
      // with a deterministic regex fallback and merge into the session.
      const followUpFields = parseFollowUp(message);
      const enriched: PartialItem = {
        category: session.partial.category,
        productName: session.partial.productName,
        reference: followUpFields.reference ?? session.partial.reference,
        condition: followUpFields.condition ?? session.partial.condition,
        expirationDate: followUpFields.expirationDate ?? session.partial.expirationDate,
        quantity: followUpFields.quantity ?? session.partial.quantity,
      };

      const result = await processSessionItem(enriched, session, deps, today);
      const parts = [result.text];
      if (session.quotedItems.length > 0) {
        parts.push(
          `📋 ${session.quotedItems.length} item(s) in your quote. Send /quote anytime for the PDF.`,
        );
      }
      return {
        text: parts.join("\n\n"),
        shouldRouteToHuman: result.routeToHuman,
        pdfBuffer: null,
      };
    }

    // True greeting — no active conversation.
    const queueNote =
      session.quotedItems.length > 0
        ? `\n\nYou have ${session.quotedItems.length} item(s) in your quote. Send /quote to get your PDF.`
        : "";

    if (!extraction.isGreeting) {
      // The LLM said "not a greeting" but returned 0 items and there's no
      // active partial. The seller likely mentioned something supply-related
      // that the LLM couldn't parse. Route to human to be safe.
      return {
        text:
          "I wasn't able to identify that product. " +
          "Let me connect you with a team member who can help." +
          queueNote,
        shouldRouteToHuman: true,
        pdfBuffer: null,
      };
    }

    return {
      text: INTRO + queueNote,
      shouldRouteToHuman: false,
      pdfBuffer: null,
    };
  }

  // ---- process items ----
  const responses: string[] = [];
  let routeToHuman = false;

  // First item: check for unrecognized product BEFORE merging.
  // If the seller named a product the LLM couldn't match (rawProductDescription
  // is set, but category/productName are null), route to human immediately.
  const firstItem = extraction.items[0]!;
  const isUnrecognized =
    !firstItem.category &&
    !firstItem.productName &&
    !!firstItem.rawProductDescription;

  if (isUnrecognized) {
    session.partial = { ...EMPTY_PARTIAL };
    const desc = firstItem.rawProductDescription!;
    responses.push(
      `"${desc}" isn't on our current price list. ` +
        `Let me connect you with a team member for a manual quote.`,
    );
    routeToHuman = true;
  } else {
    const merged = mergePartial(session.partial, firstItem);
    const firstResult = await processSessionItem(merged, session, deps, today);
    responses.push(firstResult.text);
    if (firstResult.routeToHuman) routeToHuman = true;
  }

  // Additional items (if multi-item message): process independently
  for (let i = 1; i < extraction.items.length; i++) {
    const extraItem = extraction.items[i]!;
    const extraUnrecognized =
      !extraItem.category &&
      !extraItem.productName &&
      !!extraItem.rawProductDescription;

    if (extraUnrecognized) {
      responses.push(
        `"${extraItem.rawProductDescription!}" isn't on our current price list. ` +
          `Let me connect you with a team member for a manual quote.`,
      );
      routeToHuman = true;
    } else {
      const asPartial: PartialItem = {
        category: extraItem.category,
        productName: extraItem.productName,
        reference: extraItem.reference,
        condition: extraItem.condition,
        expirationDate: extraItem.expirationDate,
        quantity: extraItem.quantity,
      };
      const result = await processSessionItem(asPartial, session, deps, today);
      responses.push(result.text);
      if (result.routeToHuman) routeToHuman = true;
    }
  }

  // Queue reminder
  if (session.quotedItems.length > 0) {
    responses.push(
      `📋 ${session.quotedItems.length} item(s) in your quote. Send /quote anytime for the PDF.`,
    );
  }

  return {
    text: responses.join("\n\n"),
    shouldRouteToHuman: routeToHuman,
    pdfBuffer: null,
  };
}

// ---- single-item processing ----

async function processSessionItem(
  merged: PartialItem,
  session: Session,
  deps: SessionDeps,
  today: Date,
): Promise<{ text: string; routeToHuman: boolean }> {
  // Check minimum identity fields
  if (!merged.category || !merged.productName) {
    session.partial = { ...merged };
    return { text: askForMissing(merged), routeToHuman: false };
  }

  // Default condition to mint if not specified
  const condition = (merged.condition ?? "mint") as RequestCondition;

  // Parse expiration date
  let expDate: Date | null = null;
  if (merged.expirationDate) {
    expDate = new Date(merged.expirationDate + "T00:00:00Z");
    if (Number.isNaN(expDate.getTime())) expDate = null;
  }

  // Engine lookup
  const rows = await deps.queryPrices(
    merged.category,
    merged.productName,
    merged.reference,
  );

  const request: PriceLookupRequest = {
    category: merged.category,
    productName: merged.productName,
    reference: merged.reference,
    condition,
    expirationDate: expDate,
  };

  const result = lookupPrice(request, rows, deps.rules, today);

  switch (result.status) {
    case "found": {
      const qty = merged.quantity ?? null;
      const quoteItem: QuoteItem = {
        productName: merged.productName,
        reference: merged.reference,
        condition,
        quantity: qty,
        unitPrice: result.finalPrice,
        totalPrice: qty !== null ? result.finalPrice * qty : null,
        basePriceId: result.basePriceId,
        adjustmentRuleId: result.adjustmentRuleId,
      };
      session.quotedItems.push(quoteItem);
      session.partial = { ...EMPTY_PARTIAL };
      return {
        text: `✅ ${formatItemLine(quoteItem)}\n\nAnything else to add?`,
        routeToHuman: false,
      };
    }

    case "not_purchased": {
      if (result.reason.includes("Expiration date")) {
        session.partial = { ...merged, condition };
        return {
          text: "Got it! What's the expiration date on the box?",
          routeToHuman: false,
        };
      }
      session.partial = { ...EMPTY_PARTIAL };
      return {
        text: `We're not currently buying that. ${result.reason}`,
        routeToHuman: false,
      };
    }

    case "not_found": {
      session.partial = { ...EMPTY_PARTIAL };
      return {
        text: "I don't have that item in our system. Let me connect you with a team member.",
        routeToHuman: true,
      };
    }

    case "expired_too_old": {
      session.partial = { ...EMPTY_PARTIAL };
      return {
        text: `Sorry, that item is too old for us to accept. ${result.reason}`,
        routeToHuman: false,
      };
    }
  }
}

// ---- helpers ----

function formatItemLine(item: QuoteItem): string {
  const ref = item.reference ? ` (${item.reference})` : "";
  const cond = item.condition.replace("_", " ");
  const qty = item.quantity !== null ? `${item.quantity} × ` : "";
  const total =
    item.totalPrice !== null ? ` — total $${item.totalPrice}` : "";
  return `${item.productName}${ref}, ${cond}: ${qty}$${item.unitPrice}/unit${total}`;
}

function askForMissing(partial: PartialItem): string {
  const missing: string[] = [];

  if (!partial.category && !partial.productName) {
    missing.push("which product you have (e.g. Accu-Chek Aviva 100, Freestyle Libre 3, Dexcom G7 sensor)");
  } else if (!partial.productName) {
    missing.push("the specific product name");
  }

  if (!partial.expirationDate) {
    missing.push("the expiration date");
  }

  if (!partial.quantity) {
    missing.push("how many boxes/packs");
  }

  if (missing.length === 0) {
    return "Could you tell me more about the item?";
  }

  return `Got it! I still need: ${missing.join("; ")}`;
}

// ---- regex fallback for follow-up messages ----

/** Month name → month number (1-indexed). English + Spanish. */
const MONTH_NAMES: Record<string, number> = {
  // English
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
  // Spanish
  ene: 1, enero: 1, febrero: 2, marzo: 3,
  abr: 4, abril: 4, mayo: 5, junio: 6,
  julio: 7, ago: 8, agosto: 8, septiembre: 9,
  octubre: 10, noviembre: 11, dic: 12, diciembre: 12,
};

const MONTH_WORD_RE = new RegExp(
  `\\b(${Object.keys(MONTH_NAMES).join("|")})\\s+(20\\d{2})\\b`,
  "i",
);

interface FollowUpFields {
  expirationDate: string | null;
  quantity: number | null;
  condition: string | null;
  reference: string | null;
}

/**
 * Deterministic regex parser for follow-up messages.
 * Extracts expiration dates, quantities, and conditions from free text
 * without an LLM call. Handles English and Spanish.
 *
 * Runs ONLY when the LLM extraction returns 0 items and the session has
 * an active partial — this is the safety net, not the primary path.
 */
export function parseFollowUp(message: string): FollowUpFields {
  const result: FollowUpFields = {
    expirationDate: null,
    quantity: null,
    condition: null,
    reference: null,
  };

  // ---- expiration date ----

  // "May 2027", "mayo 2027", "december 2026"
  let m = message.match(MONTH_WORD_RE);
  if (m) {
    const month = MONTH_NAMES[m[1]!.toLowerCase()];
    if (month) {
      result.expirationDate = `${m[2]}-${String(month).padStart(2, "0")}-01`;
    }
  }

  // "5/2027", "05/2027", "12/2026"
  if (!result.expirationDate) {
    m = message.match(/\b(\d{1,2})\/(20\d{2})\b/);
    if (m) {
      const mo = parseInt(m[1]!, 10);
      if (mo >= 1 && mo <= 12) {
        result.expirationDate = `${m[2]}-${String(mo).padStart(2, "0")}-01`;
      }
    }
  }

  // "5/27", "05/27" (two-digit year)
  if (!result.expirationDate) {
    m = message.match(/\b(\d{1,2})\/(\d{2})\b/);
    if (m) {
      const mo = parseInt(m[1]!, 10);
      if (mo >= 1 && mo <= 12) {
        result.expirationDate = `20${m[2]}-${String(mo).padStart(2, "0")}-01`;
      }
    }
  }

  // ---- quantity ----

  // "10 boxes", "5 packs", "10 cajas", "3 unidades"
  m = message.match(
    /\b(\d+)\s*(?:box|boxes|pack|packs|cajas?|unidad(?:es)?|ct)\b/i,
  );
  if (m) {
    const qty = parseInt(m[1]!, 10);
    if (qty > 0 && qty < 10000) result.quantity = qty;
  }

  // Bare number if no unit-based match: "I have 10", "tengo 10"
  if (result.quantity === null) {
    m = message.match(/\b(?:have|tengo|got)\s+(\d+)\b/i);
    if (m) {
      const qty = parseInt(m[1]!, 10);
      if (qty > 0 && qty < 10000) result.quantity = qty;
    }
  }

  // ---- condition ----

  const lower = message.toLowerCase();
  if (/\b(?:sealed|sellad[ao]s?|new|nuev[ao]s?|mint|unopened|cerrad[ao]s?)\b/.test(lower)) {
    result.condition = "mint";
  } else if (/\b(?:ding(?:ed)?|golpead[ao]s?)\b/.test(lower)) {
    result.condition = "ding";
  } else if (/\b(?:damaged|dañad[ao]s?|broken|rot[ao]s?)\b/.test(lower)) {
    result.condition = "damaged";
  } else if (/\b(?:expired|vencid[ao]s?|expirad[ao]s?)\b/.test(lower)) {
    result.condition = "expired";
  } else if (/\b(?:short[\s-]?date)\b/.test(lower)) {
    result.condition = "short_date";
  }

  // ---- reference (Dexcom codes) ----
  m = message.match(/\b(?:ref(?:erence)?|code|lot)[:\s]*(\w+)\b/i);
  if (m) {
    result.reference = m[1]!;
  }

  return result;
}

// ---- closing phrase detection ----

/**
 * Detect "that's all" / "no more" / Spanish equivalents.
 * Runs BEFORE the LLM call — deterministic, zero cost, instant.
 * Only triggers when the session has accumulated items.
 */
const CLOSING_PATTERNS = [
  // English
  /\bthat'?s?\s+(?:all|it)\b/i,
  /\bno\s+(?:more|thanks|thank\s*you)\b/i,
  /\bnothing\s+(?:else|more)\b/i,
  /\bi'?m\s+done\b/i,
  /\bdone$/i,
  /\ball\s+(?:done|set|good)\b/i,
  // Spanish
  /\bsolo\s+eso\b/i,
  /\bes\s+todo\b/i,
  /\bya\s+no\s+m[aá]s\b/i,
  /\bnada\s+m[aá]s\b/i,
  /\bno\s+m[aá]s\b/i,
  /\beso\s+es\s+todo\b/i,
  /\blisto\b/i,
];

export function isClosingPhrase(message: string): boolean {
  const trimmed = message.trim();
  // Short messages only — a long message with "that's all" embedded in a
  // product description shouldn't trigger the quote.
  if (trimmed.length > 60) return false;
  return CLOSING_PATTERNS.some((re) => re.test(trimmed));
}
