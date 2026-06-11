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

export interface DisambiguationState {
  candidates: Array<{ category: string; productName: string }>;
  /** The other extracted fields to carry forward after the seller picks a product. */
  baseItem: PartialItem;
}

export interface Session {
  partial: PartialItem;
  quotedItems: QuoteItem[];
  disambiguation?: DisambiguationState;
  /** Available reference codes when a Dexcom product is selected but no ref given. */
  pendingReferences?: string[];
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
  searchProducts: (
    partialName: string,
  ) => Promise<Array<{ category: string; productName: string }>>;
  queryReferences: (
    category: string,
    productName: string,
  ) => Promise<string[]>;
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
  const lines = session.quotedItems.map(formatQuoteLine);
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

  // ---- pending reference resolution (skips LLM call) ----
  if (session.pendingReferences && session.pendingReferences.length > 0) {
    const ref = resolveReference(message, session.pendingReferences);
    if (ref) {
      session.partial = { ...session.partial, reference: ref };
      session.pendingReferences = undefined;
      const result = await processSessionItem(
        session.partial, session, deps, today, null, true,
      );
      const parts = [result.text];
      if (session.quotedItems.length > 0) {
        parts.push(queueReminder(session.quotedItems.length));
      }
      return {
        text: parts.join("\n\n"),
        shouldRouteToHuman: result.routeToHuman,
        pdfBuffer: null,
      };
    }
    // Couldn't resolve — clear and fall through to extraction
    session.pendingReferences = undefined;
  }

  // ---- closing phrase → auto-trigger /quote (skips LLM call) ----
  if (session.quotedItems.length > 0 && isClosingPhrase(message)) {
    return handleQuoteCommand(chatId, store);
  }

  // ---- disambiguation reply (skips LLM call) ----
  if (session.disambiguation) {
    try {
      const resolved = resolveDisambiguation(message, session.disambiguation);
      if (resolved) {
        const enriched: PartialItem = {
          ...session.disambiguation.baseItem,
          category: resolved.category,
          productName: resolved.productName,
        };
        session.disambiguation = undefined;
        session.partial = { ...EMPTY_PARTIAL };

        // Dexcom products need a reference — check before engine lookup
        const refResult = await checkReferenceNeeded(
          enriched, session, deps,
        );
        if (refResult) {
          const parts = [refResult.text];
          if (session.quotedItems.length > 0) {
            parts.push(queueReminder(session.quotedItems.length));
          }
          return { text: parts.join("\n\n"), shouldRouteToHuman: false, pdfBuffer: null };
        }

        const result = await processSessionItem(
          enriched, session, deps, today, null, true,
        );
        const parts = [result.text];
        if (session.quotedItems.length > 0) {
          parts.push(queueReminder(session.quotedItems.length));
        }
        return {
          text: parts.join("\n\n"),
          shouldRouteToHuman: result.routeToHuman,
          pdfBuffer: null,
        };
      }
      // Couldn't resolve — clear disambiguation and fall through to normal extraction
      session.disambiguation = undefined;
    } catch (err) {
      console.error("Disambiguation resolution failed:", err);
      session.disambiguation = undefined;
      return {
        text: "Something went wrong. Could you describe the item again?",
        shouldRouteToHuman: false,
        pdfBuffer: null,
      };
    }
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
        parts.push(queueReminder(session.quotedItems.length));
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

  // First item: merge with session partial, then process.
  // Pass rawProductDescription as a search hint for disambiguation —
  // but disambiguation also triggers when the product identity is
  // incomplete or doesn't match the DB, regardless of this hint.
  const firstItem = extraction.items[0]!;

  // Pre-merge guard: if the extraction names a product the LLM couldn't match
  // (rawProductDescription set but no identity), the seller is describing
  // something new — clear the session partial to prevent the old product
  // identity from carrying over into the merge.
  if (
    firstItem.rawProductDescription &&
    !firstItem.category &&
    !firstItem.productName
  ) {
    session.partial = { ...EMPTY_PARTIAL };
  }

  const merged = mergePartial(session.partial, firstItem);
  const firstHint = firstItem.rawProductDescription ?? firstItem.productName ?? null;
  const firstResult = await processSessionItem(
    merged, session, deps, today, firstHint,
  );
  responses.push(firstResult.text);
  if (firstResult.routeToHuman) routeToHuman = true;

  // Additional items (if multi-item message): process independently
  for (let i = 1; i < extraction.items.length; i++) {
    const extraItem = extraction.items[i]!;
    const asPartial: PartialItem = {
      category: extraItem.category,
      productName: extraItem.productName,
      reference: extraItem.reference,
      condition: extraItem.condition,
      expirationDate: extraItem.expirationDate,
      quantity: extraItem.quantity,
    };
    const extraHint = extraItem.rawProductDescription ?? extraItem.productName ?? null;
    const result = await processSessionItem(
      asPartial, session, deps, today, extraHint,
    );
    responses.push(result.text);
    if (result.routeToHuman) routeToHuman = true;
  }

  // Queue reminder
  if (session.quotedItems.length > 0) {
    responses.push(queueReminder(session.quotedItems.length));
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
  searchHint?: string | null,
  skipDisambiguation?: boolean,
): Promise<{ text: string; routeToHuman: boolean }> {
  // ---- disambiguation for incomplete identity ----
  if (!merged.category || !merged.productName) {
    if (skipDisambiguation) {
      session.partial = { ...merged };
      return { text: askForMissing(merged), routeToHuman: false };
    }
    // We have partial info. Try to find matching products in the DB.
    const term = searchHint ?? merged.productName;
    if (term) {
      const result = await attemptDisambiguation(term, merged, session, deps, today);
      if (result) return result;
      // Had a search term but no DB matches. If the seller described a
      // specific product (searchHint set), route to human — they named
      // something that's not on our sheet.
      if (searchHint) {
        session.partial = { ...EMPTY_PARTIAL };
        return {
          text:
            `"${searchHint}" isn't on our current price list. ` +
            `Let me connect you with a team member who can help.`,
          routeToHuman: true,
        };
      }
    } else if (merged.category) {
      // No search term at all, but we know the category.
      // List all products in this category for the seller to pick from.
      const allInCategory = await deps.searchProducts("");
      const categoryProducts = allInCategory.filter(
        (c) => c.category === merged.category,
      );
      if (
        categoryProducts.length > 0 &&
        categoryProducts.length <= MAX_DISAMBIGUATION_OPTIONS
      ) {
        session.disambiguation = {
          candidates: categoryProducts,
          baseItem: { ...merged, productName: null },
        };
        session.partial = { ...EMPTY_PARTIAL };
        return {
          text: formatDisambiguation("that category", categoryProducts),
          routeToHuman: false,
        };
      }
      // Too many or zero → fall through to askForMissing
    }
    // No search term or no searchHint → ask for more info
    session.partial = { ...merged };
    return { text: askForMissing(merged), routeToHuman: false };
  }

  // Default condition to mint if not specified
  const condition = (merged.condition ?? "mint") as RequestCondition;

  // At this point, category and productName are guaranteed non-null
  // (the incomplete-identity block above returned early if either was null).
  const category = merged.category!;
  const productName = merged.productName!;

  // Parse expiration date
  let expDate: Date | null = null;
  if (merged.expirationDate) {
    expDate = new Date(merged.expirationDate + "T00:00:00Z");
    if (Number.isNaN(expDate.getTime())) expDate = null;
  }

  // Engine lookup
  let rows = await deps.queryPrices(
    category,
    productName,
    merged.reference,
  );

  // If no rows and no reference, check if the product needs one (Dexcom).
  // This prevents infinite recursion: without this check, lookupPrice returns
  // not_found → disambiguation finds the same product → calls us again → loop.
  if (rows.length === 0 && merged.reference === null) {
    const availableRefs = await deps.queryReferences(
      category,
      productName,
    );
    if (availableRefs.length === 1) {
      // Single reference → auto-select and re-query
      merged = { ...merged, reference: availableRefs[0]! };
      rows = await deps.queryPrices(
        category,
        productName,
        merged.reference,
      );
    } else if (availableRefs.length > 1) {
      // Multiple references → ask the seller
      session.partial = { ...merged, condition };
      session.pendingReferences = availableRefs;
      return {
        text: formatReferencePrompt(productName, availableRefs),
        routeToHuman: false,
      };
    }
    // 0 references → product truly doesn't exist, fall through to lookupPrice → not_found
  }

  if (rows.length === 0) {
    // No rows found. Try disambiguation (partial name match) unless we've
    // already been through this path (skipDisambiguation prevents the infinite
    // loop: Dexcom product → 0 rows → same product found → processSessionItem
    // → 0 rows → ...).
    if (!skipDisambiguation) {
      const term = searchHint ?? productName;
      if (term) {
        const disambigResult = await attemptDisambiguation(
          term, merged, session, deps, today,
        );
        if (disambigResult) return disambigResult;
      }
    }
    // Truly not found — route to human
    session.partial = { ...EMPTY_PARTIAL };
    return {
      text:
        "I don't have that in our system, but let me connect you " +
        "with a team member who can look into it for you.",
      routeToHuman: true,
    };
  }

  const request: PriceLookupRequest = {
    category: category,
    productName: productName,
    reference: merged.reference,
    condition,
    expirationDate: expDate,
  };

  const result = lookupPrice(request, rows, deps.rules, today);

  switch (result.status) {
    case "found": {
      const qty = merged.quantity ?? null;
      const quoteItem: QuoteItem = {
        productName: productName,
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
        text: formatFoundResponse(quoteItem),
        routeToHuman: false,
      };
    }

    case "not_purchased": {
      if (result.reason.includes("Expiration date")) {
        session.partial = { ...merged, condition };
        return {
          text: "I found that product! When does it expire? Just the month and year is fine.",
          routeToHuman: false,
        };
      }
      session.partial = { ...EMPTY_PARTIAL };
      return {
        text:
          `Unfortunately we can't take that one right now — ${result.reason} ` +
          `Would you like to try another item?`,
        routeToHuman: false,
      };
    }

    case "not_found": {
      session.partial = { ...EMPTY_PARTIAL };
      return {
        text:
          "I don't have that in our system, but let me connect you " +
          "with a team member who can look into it for you.",
        routeToHuman: true,
      };
    }

    case "expired_too_old": {
      session.partial = { ...EMPTY_PARTIAL };
      return {
        text:
          `Unfortunately that one's too old for us — ${result.reason} ` +
          `Would you like to try another item?`,
        routeToHuman: false,
      };
    }
  }
}

// ---- disambiguation ----

const MAX_DISAMBIGUATION_OPTIONS = 8;

/**
 * Search for candidate products and either auto-select, present options,
 * or return null (no matches / too many). Called from processSessionItem
 * when the product identity is incomplete or doesn't match the DB.
 */
async function attemptDisambiguation(
  searchTerm: string,
  merged: PartialItem,
  session: Session,
  deps: SessionDeps,
  today: Date,
): Promise<{ text: string; routeToHuman: boolean } | null> {
  const allCandidates = await deps.searchProducts(searchTerm);

  // If we know the category, narrow to it
  const candidates = merged.category
    ? allCandidates.filter((c) => c.category === merged.category)
    : allCandidates;

  if (candidates.length === 0) {
    // No matches in the DB — return null to let the caller handle it
    // (either askForMissing or route to human depending on context).
    return null;
  }

  if (candidates.length === 1) {
    // Single match → auto-select and process immediately
    const match = candidates[0]!;
    const enriched: PartialItem = {
      ...merged,
      category: match.category,
      productName: match.productName,
    };
    return processSessionItem(enriched, session, deps, today);
  }

  if (candidates.length <= MAX_DISAMBIGUATION_OPTIONS) {
    // Multiple matches → store candidates and present options
    session.disambiguation = {
      candidates,
      baseItem: {
        ...merged,
        category: merged.category ?? null,
        productName: null,
      },
    };
    session.partial = { ...EMPTY_PARTIAL };
    return {
      text: formatDisambiguation(searchTerm, candidates),
      routeToHuman: false,
    };
  }

  // Too many matches
  session.partial = { ...merged };
  return {
    text:
      `That matches quite a few products in our system. ` +
      `Could you be a bit more specific? For example, include the pack size or count.`,
    routeToHuman: false,
  };
}

function formatDisambiguation(
  description: string,
  candidates: Array<{ category: string; productName: string }>,
): string {
  const lines = candidates.map(
    (c, i) => `${i + 1}. ${c.productName}`,
  );
  return (
    `I found a few options that could match "${description}" — which one do you have?\n\n` +
    lines.join("\n") +
    "\n\nJust reply with the number or the product name."
  );
}

/**
 * Try to resolve a disambiguation reply. Handles number selection ("1", "2")
 * and partial name matching ("the 100", "100 count").
 */
export function resolveDisambiguation(
  message: string,
  state: DisambiguationState,
): { category: string; productName: string } | null {
  const trimmed = message.trim();

  // Number selection: "1", "2", etc.
  const num = parseInt(trimmed, 10);
  if (!Number.isNaN(num) && num >= 1 && num <= state.candidates.length) {
    return state.candidates[num - 1]!;
  }

  // Text match: case-insensitive, check both directions.
  // Require at least 2 characters to avoid spurious single-char matches.
  if (trimmed.length < 2) return null;
  const lower = trimmed.toLowerCase();
  const match = state.candidates.find(
    (c) =>
      c.productName.toLowerCase().includes(lower) ||
      lower.includes(c.productName.toLowerCase()),
  );
  if (match) return match;

  return null;
}

// ---- reference handling (Dexcom products) ----

/**
 * After disambiguation resolves a product, check if it needs a reference
 * code before the engine can look up a price. If so, store pending refs
 * and return a prompt. If not (or single ref → auto-select), return null.
 */
async function checkReferenceNeeded(
  enriched: PartialItem,
  session: Session,
  deps: SessionDeps,
): Promise<{ text: string; routeToHuman: boolean } | null> {
  if (enriched.reference || !enriched.category || !enriched.productName) {
    return null; // already has a reference, or incomplete identity
  }

  const refs = await deps.queryReferences(
    enriched.category,
    enriched.productName,
  );

  if (refs.length <= 1) {
    // 0 refs = no reference needed (or product doesn't exist)
    // 1 ref = auto-select (handled in processSessionItem)
    return null;
  }

  // Multiple references — ask the seller
  session.partial = { ...enriched };
  session.pendingReferences = refs;
  return {
    text: formatReferencePrompt(enriched.productName, refs),
    routeToHuman: false,
  };
}

/**
 * Try to match a message against a list of pending reference codes.
 * Handles number selection ("1"), exact match ("012"), and bare text.
 */
export function resolveReference(
  message: string,
  availableRefs: string[],
): string | null {
  const trimmed = message.trim();

  // Number selection
  const num = parseInt(trimmed, 10);
  if (
    !Number.isNaN(num) &&
    num >= 1 &&
    num <= availableRefs.length &&
    String(num) === trimmed
  ) {
    return availableRefs[num - 1]!;
  }

  // Exact match (case-insensitive)
  const lower = trimmed.toLowerCase();
  const exact = availableRefs.find(
    (r) => r.toLowerCase() === lower,
  );
  if (exact) return exact;

  // Substring match: "OR & OM" from "the OR & OM one"
  const sub = availableRefs.find(
    (r) => lower.includes(r.toLowerCase()),
  );
  if (sub) return sub;

  return null;
}

function formatReferencePrompt(
  productName: string,
  refs: string[],
): string {
  const lines = refs.map((r, i) => `${i + 1}. ${r}`);
  return (
    `Which reference code? For ${productName}, the options are:\n\n` +
    lines.join("\n") +
    "\n\nJust reply with the number or the code."
  );
}

// ---- response helpers ----

function formatFoundResponse(item: QuoteItem): string {
  const ref = item.reference ? ` (ref ${item.reference})` : "";
  const condAdj = conditionAdjective(item.condition);
  const product = `${item.productName}${ref}`;

  if (item.quantity !== null && item.totalPrice !== null) {
    return (
      `Great — for your ${item.quantity} ${condAdj}${product}, ` +
      `we can offer $${item.unitPrice} per unit, so $${item.totalPrice} total. ` +
      `Do you have anything else you'd like to sell?`
    );
  }

  return (
    `For your ${condAdj}${product}, we can offer $${item.unitPrice} per unit. ` +
    `Do you have anything else you'd like to sell?`
  );
}

function conditionAdjective(condition: string): string {
  switch (condition) {
    case "mint":
      return "";
    case "ding":
      return "dinged ";
    case "damaged":
      return "damaged ";
    case "short_date":
      return "short-dated ";
    case "expired":
      return "expired ";
    default:
      return `${condition} `;
  }
}

function askForMissing(partial: PartialItem): string {
  const missing: string[] = [];

  if (!partial.category && !partial.productName) {
    missing.push(
      "which product it is (like Accu-Chek Aviva 100, Freestyle Libre 3, or Dexcom G7 sensor)",
    );
  } else if (!partial.productName) {
    missing.push("the specific product name");
  }

  if (!partial.expirationDate) {
    missing.push("when it expires");
  }

  if (!partial.quantity) {
    missing.push("how many boxes you have");
  }

  if (missing.length === 0) {
    return "Could you tell me a bit more about the item?";
  }

  if (missing.length === 1) {
    return `Thanks! I just need one more thing — ${missing[0]}.`;
  }

  const last = missing.pop()!;
  return `Thanks! I just need a few more details — ${missing.join(", ")}, and ${last}.`;
}

function queueReminder(count: number): string {
  const items = count === 1 ? "1 item" : `${count} items`;
  return (
    `You now have ${items} in your quote — ` +
    `send /quote or say "that's all" whenever you're ready for the PDF.`
  );
}

/** Compact line format for the /quote summary list. */
function formatQuoteLine(item: QuoteItem): string {
  const ref = item.reference ? ` (${item.reference})` : "";
  const condAdj = conditionAdjective(item.condition);
  const qty = item.quantity !== null ? `${item.quantity} × ` : "";
  const total =
    item.totalPrice !== null ? ` — $${item.totalPrice} total` : "";
  return `${condAdj}${item.productName}${ref}: ${qty}$${item.unitPrice}/unit${total}`;
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
  /\ball\s+(?:done|set|good|ready)\b/i,
  /\balready$/i,
  /^no,?\s*(?:all\s*ready|already)$/i,
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
