# MAXMED Price-Quote Chatbot

Customer-facing chatbot for MAXMED Distributors — a business that **buys** diabetic supplies from sellers. The bot quotes prices from the official price sheet with guaranteed grounding: every price comes from an exact database lookup, never from the LLM.

## Architecture

Telegram → LLM extracts (JSON) → Deterministic price engine (PostgreSQL) → LLM phrases → Reply + PDF quote

**The LLM never calculates a price.** It is bracketed by code on both ends.

## Quick start

```bash
npm install
cp .env.example .env        # set DATABASE_URL, TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY
npm run db:generate
npm run db:migrate           # name: "init"
npm run import               # loads the price sheet into the database
npm test                     # run grounding tests
npm run dev                  # start the bot
```

## Full README — Phase 5
