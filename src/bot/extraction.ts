/**
 * Extraction step: seller's free-text message → structured JSON.
 *
 * Uses Claude tool_use to guarantee structured output. The system prompt
 * contains the product catalog (names + references only, NEVER prices)
 * so the LLM can match seller descriptions to exact DB identifiers.
 *
 * Returns null for anything uncertain — the handler routes those to a human.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { RequestCondition } from "../engine/types.js";

export interface ExtractionItem {
  category: string | null;
  productName: string | null;
  reference: string | null;
  condition: RequestCondition | null;
  expirationDate: string | null; // "YYYY-MM-DD"
  quantity: number | null;
  /** What the seller called the product, verbatim. Set even when the product
   *  doesn't match any catalog entry. Null only when no product was mentioned
   *  at all (pure follow-up with just date/qty). */
  rawProductDescription: string | null;
}

export interface ExtractionResult {
  items: ExtractionItem[];
  isGreeting: boolean;
}

const EXTRACTION_TOOL: Anthropic.Tool = {
  name: "extract_supply_info",
  description:
    "Extract structured information about diabetic supplies from a seller's message.",
  input_schema: {
    type: "object" as const,
    properties: {
      items: {
        type: "array",
        description:
          "Extracted supply items. Empty array ONLY if the message is a pure greeting with no supply information at all. " +
          "If the seller mentions ANY product or supply — even one not in the catalog — return an item.",
        items: {
          type: "object",
          properties: {
            category: {
              type: "string",
              description:
                'One of: "test_strips", "libre", "dexcom_g6", "dexcom_g7". Use null if uncertain or product is not in catalog.',
            },
            productName: {
              type: "string",
              description:
                "Exact product name from the catalog. Must match EXACTLY. Use null if the product is not in the catalog or uncertain.",
            },
            reference: {
              type: "string",
              description:
                "Reference/lot code for Dexcom products (e.g. OE, 012). null if not applicable or not mentioned.",
            },
            condition: {
              type: "string",
              enum: ["mint", "ding", "damaged", "short_date", "expired"],
              description:
                'Item condition. "mint" = sealed/new/good condition (default if not mentioned). ' +
                '"ding" = minor packaging damage. "damaged" = significant damage. ' +
                '"short_date" = close to expiration. "expired" = past expiration date. ' +
                "null if genuinely ambiguous.",
            },
            expirationDate: {
              type: "string",
              description:
                "Expiration date as YYYY-MM-DD. Use the 1st of the month if only month/year given " +
                '(e.g. "May 2027" → "2027-05-01"). null if not mentioned.',
            },
            quantity: {
              type: "integer",
              description:
                "Number of boxes/packs the seller has. null if not mentioned.",
            },
            rawProductDescription: {
              type: "string",
              description:
                "The seller's original description of the product, verbatim or close to it " +
                '(e.g. "Omnipod Dash pods", "Medtronic pump supplies"). ' +
                "ALWAYS set this when the seller mentions a product, even if it doesn't match any catalog entry. " +
                "null ONLY when no product was mentioned at all (e.g. a pure follow-up like 'expires May 2027').",
            },
          },
          required: [
            "category",
            "productName",
            "reference",
            "condition",
            "expirationDate",
            "quantity",
            "rawProductDescription",
          ],
        },
      },
      isGreeting: {
        type: "boolean",
        description:
          "true if the message is a greeting, question about the service, or not about selling specific supplies.",
      },
    },
    required: ["items", "isGreeting"],
  },
};

function buildSystemPrompt(catalogText: string): string {
  return `You are an extraction assistant for MAXMED Distributors, a company that BUYS diabetic supplies from sellers.

Your job: extract structured product information from a seller's message. You NEVER produce or guess prices — you only identify WHAT the seller has.

RULES:
1. Use ONLY the exact product names from the catalog below. If you cannot confidently match a seller's description to an exact product name, set productName to null.
2. For Dexcom products, extract the reference/lot code. If the seller doesn't mention one, set reference to null.
3. Default condition to "mint" if the seller says sealed, new, unopened, or doesn't mention condition.
4. Parse expiration dates into YYYY-MM-DD format. Use the 1st of the month if only month/year is given.
5. Set any field to null if you are not confident about the value.
6. NEVER ask about or reference the seller's health in any way.
7. If the message is ONLY a greeting or general question with NO supply-related details at all, set isGreeting to true and return an empty items array.
8. IMPORTANT — partial follow-ups: if the message contains supply-related details (expiration date, quantity, condition) but does NOT name a specific product, you MUST still return an item with category and productName set to null but the other fields filled in. Set rawProductDescription to null in this case. The system uses conversation history to fill in the product. Never return an empty items array when the message has extractable supply information.
9. IMPORTANT — unrecognized products: if the seller names a product that is NOT in the catalog (e.g. "Omnipod Dash", "Medtronic pump supplies"), you MUST still return an item with category and productName set to null, but set rawProductDescription to the seller's original product description. Never return an empty items array when the seller mentions a product — even one not in the catalog.

PRODUCT CATALOG (use these exact names):

${catalogText}`;
}

export function createExtractor(
  client: Anthropic,
  catalogText: string,
  model: string = "claude-haiku-4-5-20251001",
) {
  const systemPrompt = buildSystemPrompt(catalogText);

  return async function extract(
    sellerMessage: string,
  ): Promise<ExtractionResult> {
    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: sellerMessage }],
      tools: [EXTRACTION_TOOL],
      tool_choice: { type: "tool", name: "extract_supply_info" },
    });

    const toolBlock = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    if (!toolBlock) {
      throw new Error("Extraction LLM did not return a tool_use block.");
    }

    const raw = toolBlock.input as Record<string, unknown>;

    return {
      items: Array.isArray(raw.items)
        ? (raw.items as ExtractionItem[])
        : [],
      isGreeting: Boolean(raw.isGreeting),
    };
  };
}
