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
PDFKit (quote PDF), ExcelJS (parser), Vitest (217 grounding + pipeline tests).
No n8n, no vector search — pricing is exact lookup.

## Data model (two tables)

- **`BasePrice`** — every explicit price, keyed by
  `(category, productName, reference)` × `condition`
  (`mint` / `damaged` / `short_date` / `expired`) × an explicit expiration
  date range (`dateFrom`/`dateTo`, matched newest→oldest, first match wins;
  null range = non-expiring / flat condition). Price is nullable — `null`
  means "not currently purchased" (e.g. damaged test strips today), and the
  owner can re-enable it by editing the Excel and re-importing. Zero code
  changes.
- **`AdjustmentRule`** — ding deltas only (e.g. `−3.00`). Linked to mint
  rows via `scopeKey`. Changing a ding from −$3 to −$4 is a one-row edit.

See `prisma/schema.prisma` for annotated definitions.

## Conversation flow

The bot supports multi-turn conversations with incremental information
gathering and multi-item accumulation.

**Session memory.** Each Telegram chat has an in-memory session
(`Map<chatId, Session>`) that stores partially-extracted fields and
accumulated quote items. When a new message arrives, the LLM extracts
whatever fields are present, and the session merge fills in the rest from
previous messages. This handles the natural "partial info → follow-up"
flow:

```
Seller: "I have some Aviva 100 test strips"
Bot:    "Got it! I still need: the expiration date; how many boxes/packs"

Seller: "exp May 2027, 10 boxes"
Bot:    "✅ Accu-Chek Aviva plus 100, mint: 10 × $60/unit — total $600
         Anything else to add?"
```

A deterministic regex fallback (English + Spanish) catches dates,
quantities, and conditions when the LLM returns zero items for a follow-up
message that has no product name.

**Multi-item accumulation.** After each quoted item, the bot asks "Anything
else to add?" and stores the item in the session. The seller can keep adding
items across multiple messages.

**`/quote` command.** Generates a combined PDF with all accumulated items,
a grand total, and 7-day validity terms, then clears the session.

**Auto-quote on closing phrases.** When the seller says "that's all",
"no more", "solo eso", "nada más", or similar (detected by a deterministic
regex before the LLM call — zero cost, instant), the bot automatically
triggers the `/quote` flow.

**`/start` command.** Clean welcome message explaining what the bot does
and what info to provide. Clears any existing session.

**Unrecognized products.** If the seller names a product not in the catalog
(e.g. "Omnipod Dash pods"), the extraction returns `rawProductDescription`
with the seller's text. The session handler detects this and routes to a
human immediately — it never asks "which product?" for something that isn't
on the sheet.

**Auto-clear.** Sessions expire after 10 minutes of inactivity via
`setTimeout` per session.

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
  bot/           Telegram bot + LLM calls + session management
    index.ts         grammy entry point, /start, /quote, startup loading
    session.ts       Session store, merge logic, follow-up regex, closing detection
    handler.ts       Direct pipeline (extract → lookup → phrase → PDF)
    extraction.ts    Extraction LLM (tool_use, forced structured output)
    phrasing.ts      Phrasing LLM (states exact prices, no math)
    catalog.ts       Product catalog builder (names only, never prices)
    quote.ts         PDF quote generator (PDFKit)
  lib/
    db.ts            Prisma client singleton
    env.ts           Typed, lazy environment access
  import.ts        npm run import — transactional DB rebuild
tests/               217 tests across 8 files
  dates.test.ts      Header parsing (15 tests)
  testStrips.test.ts Parser vs real sheet (26 tests)
  libre.test.ts      Parser vs real sheet (25 tests)
  dexcom.test.ts     Parser vs real sheet (30 tests)
  engine.test.ts     Grounding evals (42 tests)
  handler.test.ts    Pipeline wiring with mocked LLMs (15 tests)
  session.test.ts    Session merge, accumulation, auto-quote, regex fallback (63 tests)
  scaffold.test.ts   Harness smoke test (1 test)
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
npm test              # 217 tests across 8 files, all should pass

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

## Production considerations

**Date tier rollover.** The data notes say "dates roll on the 22nd of each
month." The import script (`npm run import`) rebuilds the entire DB from the
Excel in one transaction. In production, a scheduled job (cron) or an upload
trigger (file-watcher, Sheets API webhook) runs the same pipeline
automatically. The parser adapts to whatever tiers the owner puts in the
sheet — no code changes needed when tiers shift.

**Damaged test strips.** The data notes say "damaged test strips are no
longer accepted but can change next month." In the current data, the damaged
column for test strips is N/A → no `BasePrice` rows are created for that
condition. When the owner decides to accept them again, they put a price in
the Excel cell, run `npm run import`, and the bot reflects it immediately.
Zero code changes — the parser emits whatever the sheet contains, and the
engine either finds a matching row or returns "not purchased."

## What I'd do with another week

- **Smart disambiguation.** When the extraction maps to multiple possible
  products (e.g. "DEXCOM SENSOR 1 PACK" could be G6 or G7, BOX or NO BOX),
  the bot should present the options and let the seller pick rather than
  routing to a human. This requires a disambiguation step between extraction
  and engine lookup that queries the DB for matching candidates.

- **Product table.** An item where every tier is N/A (e.g. Accu-Chek Guide
  50 MO) produces zero `BasePrice` rows and is indistinguishable from an item
  not on the sheet at all. A `Product` table recording every listed item —
  including all-N/A ones — would restore the informational "we know this
  item but aren't buying it right now" vs. "let me connect you with a
  team member" distinction.

- **Persistent sessions.** The current in-memory `Map` is wiped on bot
  restart. A Redis-backed session store would survive restarts and support
  horizontal scaling across multiple bot instances.

- **Auto-sync from Google Sheets.** The owner's workflow is editing a Google
  Sheet. A Sheets API integration (webhook or polling) would detect changes
  and run the import pipeline automatically, removing the manual
  `npm run import` step entirely.

- **Admin Telegram group forwarding.** Route-to-human cases currently log to
  the console. Forwarding the seller's message (plus session context) to a
  private Telegram admin group would let the team respond directly without
  checking logs.

- **Grounding eval dashboard.** Track extraction accuracy, engine hit/miss
  rates, and route-to-human frequency over time. Flag conversations where the
  LLM extraction diverged from what the engine found, so the team can tune
  the extraction prompt or catalog coverage.