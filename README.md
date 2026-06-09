# MAXMED price-quote bot

A customer-facing Telegram bot for **MAXMED Distributors**, a business that
**buys** diabetic supplies. A seller messages describing what they have
(product, count, expiration, condition); the bot looks up the price sheet and
tells them what MAXMED will pay, then sends a PDF quote. If an item isn't on
the sheet, or anything is uncertain, it routes to a human — **it never guesses
a price**.

## The one rule that matters most: grounding

The bot is **architecturally unable to invent a price**:

```
Telegram message
  → LLM extraction (message → structured JSON; null for anything uncertain)
  → deterministic code (exact lookup / ding subtraction from PostgreSQL)
  → LLM phrasing (states the already-computed number; does no math)
  → reply + PDF quote
```

The LLM is bracketed by code on both ends. The extraction step uses `tool_use`
(forced) to produce structured output and sees the product catalog but **never
prices**. The engine is a pure function with zero LLM involvement. The phrasing
step receives finished numbers and is instructed to state them exactly. Every
`"found"` result carries a `basePriceId` (and `adjustmentRuleId` for ding)
tracing it to the exact DB row.

## Stack

TypeScript + Node 22, [grammy](https://grammy.dev) (Telegram),
Claude API (Haiku for extraction and phrasing), PostgreSQL 17 + Prisma,
PDFKit (quote PDF), ExcelJS (parser), Vitest (grounding tests).
No n8n, no vector search — pricing is exact lookup.

## Data model (two tables)

- **`BasePrice`** — every explicit price, keyed by
  `(category, productName, reference)` × `condition`
  (`mint` / `damaged` / `short_date` / `expired`) × an explicit expiration
  date range (`dateFrom`/`dateTo`, matched newest→oldest, first match wins;
  null range = non-expiring / flat condition).
- **`AdjustmentRule`** — ding deltas only (e.g. `−3.00`). Linked to mint
  rows via `scopeKey`. Changing a ding from −$3 to −$4 is a one-row edit.

See `prisma/schema.prisma` for annotated definitions.

## Project structure

```
src/
  parsers/       Excel ETL: one parser per sheet/block
    testStrips.ts    Test Strips (2 blocks, 65 prices)
    libre.ts         Libre (23 prices, non-expiring readers)
    dexcom.ts        Dexcom G6/G7 (48 prices, reference discrimination)
    dates.ts         Header → date-range translation
    helpers.ts       Cell reading, N/A detection, ding delta parsing
    types.ts         Neutral intermediate representation
  engine/        Deterministic price lookup
    lookup.ts        Pure function: (request, data, today) → result
    query.ts         Prisma ↔ engine type bridge
    types.ts         Engine request/result types with provenance
  bot/           Telegram bot + LLM calls
    index.ts         grammy entry point, startup loading
    handler.ts       Pipeline orchestrator (extract → lookup → phrase → PDF)
    extraction.ts    Extraction LLM (tool_use, forced structured output)
    phrasing.ts      Phrasing LLM (states exact prices, no math)
    catalog.ts       Product catalog builder (names only, never prices)
    quote.ts         PDF quote generator (PDFKit)
  lib/
    db.ts            Prisma client singleton
    env.ts           Typed, lazy environment access
  import.ts        npm run import — transactional DB rebuild
tests/
  dates.test.ts      Header parsing (15 tests)
  testStrips.test.ts Parser vs real sheet (26 tests)
  libre.test.ts      Parser vs real sheet (25 tests)
  dexcom.test.ts     Parser vs real sheet (30 tests)
  engine.test.ts     Grounding evals (42 tests)
  handler.test.ts    Pipeline wiring with mocked LLMs (15 tests)
```

## Setup (Windows + PowerShell, Node 22, PostgreSQL 17)

```powershell
# 1. Install dependencies
npm install

# 2. Create your env file
Copy-Item .env.example .env
#   Then edit .env — set DATABASE_URL, ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN

# 3. Generate Prisma client and apply the schema
npm run db:generate
npm run db:migrate    # name the first migration "init"

# 4. Import the price sheet into the database
npm run import        # reads data/price-sheet.xlsx, loads 136 prices + 5 rules

# 5. Run the test suite
npm test              # 151+ tests, all should pass

# 6. Start the bot
npm run dev           # watches for changes
# or
npm start             # production
```

## Updating data

The owner keeps editing the messy Excel **as-is** — the parser adapts to it.
One command re-reads the whole sheet and rebuilds the DB inside a transaction:

```powershell
npm run import
```

After import, restart the bot to refresh the in-memory catalog and rules.

## Compliance

The bot only ever asks about the supplies — **never about or implying the
seller's health**. This rule is enforced in both LLM system prompts.

## Future steps

- **Product table.** An item where every tier is N/A (e.g. Accu-Chek Guide
  50 MO) produces zero `BasePrice` rows and is indistinguishable from an item
  not on the sheet. A `Product` table recording all listed items would restore
  the informational "we don't buy that right now" vs. handoff distinction.
- **Auto-sync.** Scheduled job or Sheets API so the owner's edits flow into
  the DB without manual `npm run import`.
- **Admin forwarding.** Route-to-human messages forwarded to a Telegram admin
  group or channel for follow-up.
- **Multi-turn clarification.** Ask follow-up questions for missing fields
  (expiration date, quantity) instead of routing to human immediately.
- **Fuzzy product matching.** Tolerate minor name mismatches between the LLM
  extraction and DB product names to reduce false not-found results.
