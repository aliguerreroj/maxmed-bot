/**
 * Telegram bot entry point.
 *
 * Uses session-based message handling: each chat has an in-memory session
 * that accumulates partial extraction fields and quoted items. The seller
 * builds up items incrementally, then sends /quote for the combined PDF.
 */

import { Bot, InputFile } from "grammy";
import Anthropic from "@anthropic-ai/sdk";
import { env } from "../lib/env.js";
import { prisma } from "../lib/db.js";
import { loadAllRules, loadProductCatalog, queryProductPrices } from "../engine/query.js";
import { buildCatalogPrompt } from "./catalog.js";
import { createExtractor } from "./extraction.js";
import {
  SessionStore,
  handleSessionMessage,
  handleStartCommand,
  handleQuoteCommand,
  type SessionDeps,
} from "./session.js";

async function main(): Promise<void> {
  console.log("Loading product catalog and rules...");

  const [catalogEntries, rules] = await Promise.all([
    loadProductCatalog(prisma),
    loadAllRules(prisma),
  ]);

  const catalogText = buildCatalogPrompt(catalogEntries);
  console.log(
    `Catalog: ${catalogEntries.length} products, ${rules.size} ding rules`,
  );

  // ---- init clients ----
  const anthropic = new Anthropic({ apiKey: env.anthropicApiKey });
  const model = process.env.LLM_MODEL ?? "claude-haiku-4-5-20251001";
  const extract = createExtractor(anthropic, catalogText, model);

  // ---- session store (10 min TTL) ----
  const sessions = new SessionStore(10 * 60 * 1000);

  // ---- shared deps (no phrasing LLM for per-item responses) ----
  const deps: SessionDeps = {
    extract,
    queryPrices: (cat, name, ref) =>
      queryProductPrices(prisma, cat, name, ref),
    rules,
  };

  // ---- bot ----
  const bot = new Bot(env.telegramBotToken);

  // /start — clean welcome
  bot.command("start", async (ctx) => {
    const response = handleStartCommand(ctx.chat.id, sessions);
    await ctx.reply(response.text);
  });

  // /quote — combined PDF with all accumulated items
  bot.command("quote", async (ctx) => {
    const response = await handleQuoteCommand(ctx.chat.id, sessions);
    await ctx.reply(response.text);
    if (response.pdfBuffer) {
      await ctx.replyWithDocument(
        new InputFile(response.pdfBuffer, "MAXMED-Quote.pdf"),
      );
    }
  });

  // Regular text messages — session-based extraction + merge + lookup
  bot.on("message:text", async (ctx) => {
    try {
      const response = await handleSessionMessage(
        ctx.chat.id,
        ctx.message.text,
        sessions,
        deps,
      );

      await ctx.reply(response.text);

      if (response.pdfBuffer) {
        await ctx.replyWithDocument(
          new InputFile(response.pdfBuffer, "MAXMED-Quote.pdf"),
        );
      }

      if (response.shouldRouteToHuman) {
        console.log(
          `[ROUTE TO HUMAN] chat=${ctx.chat.id} text="${ctx.message.text}"`,
        );
      }
    } catch (err) {
      console.error("Unhandled error:", err);
      await ctx.reply(
        "Sorry, something went wrong. Let me connect you with a team member.",
      );
    }
  });

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
