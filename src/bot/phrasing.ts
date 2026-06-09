/**
 * Phrasing step: engine results → natural language reply.
 *
 * The LLM receives pre-computed prices and constructs a friendly message.
 * It is given the exact numbers and MUST NOT modify, recalculate, or round them.
 * All math has already been done by the deterministic engine.
 */

import type Anthropic from "@anthropic-ai/sdk";

export interface PhraseItem {
  productName: string;
  reference: string | null;
  condition: string;
  quantity: number | null;
  unitPrice: number;
  totalPrice: number | null; // unitPrice × quantity, or null if quantity unknown
  breakdown: string; // from engine, e.g. "Ding price: $60 mint − $3 = $57"
}

export interface PhraseInput {
  quotedItems: PhraseItem[];
  notPurchasedItems: Array<{ description: string; reason: string }>;
  notFoundItems: Array<{ description: string }>;
  expiredTooOldItems: Array<{ description: string; reason: string }>;
}

const PHRASING_SYSTEM = `You are a friendly, professional representative for MAXMED Distributors, a company that BUYS diabetic supplies.

You are responding to a seller who described supplies they want to sell. You have been given pre-computed prices.

RULES:
1. State the EXACT price numbers provided — DO NOT modify, round, recalculate, or do any math.
2. If per-unit and total prices are both given, include both. If only per-unit, state per-unit.
3. For items we can't buy (not purchased, not found, expired too old), say so politely and briefly.
4. For not-found items, say you'll connect them with a team member who can help.
5. NEVER ask about, mention, or imply anything about the seller's health or medical condition.
6. NEVER explain WHY we offer certain prices or mention our pricing structure.
7. Keep the response concise and warm. No need for lengthy explanations.
8. If there are quoted items, ask if they'd like to proceed or have questions.`;

export function createPhraser(
  client: Anthropic,
  model: string = "claude-haiku-4-5-20251001",
) {
  return async function phrase(input: PhraseInput): Promise<string> {
    const userContent = buildPhraseContent(input);

    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      system: PHRASING_SYSTEM,
      messages: [{ role: "user", content: userContent }],
    });

    const text = response.content.find(
      (b): b is Anthropic.TextBlock => b.type === "text",
    );

    return text?.text ?? "Thank you for reaching out. Let me connect you with a team member.";
  };
}

function buildPhraseContent(input: PhraseInput): string {
  const parts: string[] = [];

  if (input.quotedItems.length > 0) {
    parts.push("ITEMS WE CAN QUOTE (use these exact numbers):");
    for (const item of input.quotedItems) {
      const ref = item.reference ? ` (ref: ${item.reference})` : "";
      const qty = item.quantity ? `${item.quantity}×` : "";
      const total =
        item.totalPrice !== null
          ? ` | Total: $${item.totalPrice}`
          : "";
      parts.push(
        `  - ${item.productName}${ref}, ${item.condition}: ` +
          `${qty}$${item.unitPrice}/unit${total}`,
      );
    }
  }

  if (input.notPurchasedItems.length > 0) {
    parts.push("\nITEMS WE'RE NOT CURRENTLY BUYING:");
    for (const item of input.notPurchasedItems) {
      parts.push(`  - ${item.description}: ${item.reason}`);
    }
  }

  if (input.notFoundItems.length > 0) {
    parts.push("\nITEMS NOT IN OUR SYSTEM (route to human):");
    for (const item of input.notFoundItems) {
      parts.push(`  - ${item.description}`);
    }
  }

  if (input.expiredTooOldItems.length > 0) {
    parts.push("\nITEMS TOO OLD TO ACCEPT:");
    for (const item of input.expiredTooOldItems) {
      parts.push(`  - ${item.description}: ${item.reason}`);
    }
  }

  return parts.join("\n");
}
