/**
 * Telegram bot entry point.
 *
 * Startup: loads the product catalog + ding rules from the DB once,
 * then listens for messages and runs the pipeline per-message.
 */

import { Bot } from "grammy";
import Anthropic from "@anthropic-ai/sdk";
import { env } from "../lib/env.js";
import { prisma } from "../lib/db.js";
import { loadAllRules, loadProductCatalog, queryProductPrices } from "../engine/query.js";
import { buildCatalogPrompt } from "./catalog.js";
import { createExtractor } from "./extraction.js";
import { createPhraser } from "./phrasing.js";
import { handleMessage } from "./handler.js";

async function main(): Promise<void> {
  console.log("Loading product catalog and rules...");

  // ---- one-time startup: load catalog + rules ----
  const [catalogEntries, rules] = await Promise.all([
    loadProductCatalog(prisma),
    loadAllRules(prisma),
  ]);

  const catalogText = buildCatalogPrompt(catalogEntries);
  console.log(
    `Catalog: ${catalogEntries.length} products, ${rules.size} ding rules`,
  );

  // ---- init Anthropic client ----
  const anthropic = new Anthropic({ apiKey: env.anthropicApiKey });
  const model = process.env.LLM_MODEL ?? "claude-haiku-4-5-20251001";
  const extract = createExtractor(anthropic, catalogText, model);
  const phrase = createPhraser(anthropic, model);

  // ---- init Telegram bot ----
  const bot = new Bot(env.telegramBotToken);

  bot.on("message:text", async (ctx) => {
    try {
      const response = await handleMessage(ctx.message.text, {
        extract,
        queryPrices: (cat, name, ref) =>
          queryProductPrices(prisma, cat, name, ref),
        rules,
        phrase,
      });

      await ctx.reply(response.text);

      // If the item needs human review, forward to admin (placeholder)
      if (response.shouldRouteToHuman) {
        console.log(
          `[ROUTE TO HUMAN] chat=${ctx.chat.id} text="${ctx.message.text}"`,
        );
        // TODO Phase 5: forward to admin group or channel
      }
    } catch (err) {
      console.error("Unhandled error in message handler:", err);
      await ctx.reply(
        "Sorry, something went wrong. Let me connect you with a team member.",
      );
    }
  });

  // Ignore non-text messages gracefully
  bot.on("message", async (ctx) => {
    if (!ctx.message.text) {
      await ctx.reply(
        "I can only process text messages right now. " +
          "Please describe your supplies in a text message.",
      );
    }
  });

  bot.catch((err) => {
    console.error("Bot error:", err);
  });

  console.log("Bot is running. Waiting for messages...");
  await bot.start();
}

main().catch((err) => {
  console.error("Failed to start bot:", err);
  process.exit(1);
});

export {};
