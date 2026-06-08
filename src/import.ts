/**
 * `npm run import` — re-reads the entire price-sheet Excel and rebuilds
 * the database inside a single transaction. Idempotent: truncate + reinsert.
 *
 * Currently wired: Test Strips.
 * Libre + Dexcom parsers will be added in later phases.
 */

import ExcelJS from "exceljs";
import { prisma } from "./lib/db.js";
import { parseTestStrips } from "./parsers/testStrips.js";
import { parseLibre } from "./parsers/libre.js";
import { parseDexcom } from "./parsers/dexcom.js";
import { KNOWN_CONDITIONS, type ParseResult } from "./parsers/types.js";

const SHEET_PATH = process.argv[2] ?? "data/price-sheet.xlsx";

async function main(): Promise<void> {
  console.log(`Reading price sheet: ${SHEET_PATH}`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(SHEET_PATH);

  // ---- run parsers ----
  const allPrices: ParseResult["prices"] = [];
  const allRules: ParseResult["rules"] = [];
  const allWarnings: string[] = [];

  // Test Strips
  const ts = wb.getWorksheet("Test Strips");
  if (!ts) {
    throw new Error('Sheet "Test Strips" not found in workbook');
  }
  const tsResult = parseTestStrips(ts);
  allPrices.push(...tsResult.prices);
  allRules.push(...tsResult.rules);
  allWarnings.push(...tsResult.warnings.map((w) => `[Test Strips] ${w}`));

  // Libres
  const libWs = wb.getWorksheet("Libres");
  if (!libWs) {
    throw new Error('Sheet "Libres" not found in workbook');
  }
  const libResult = parseLibre(libWs);
  allPrices.push(...libResult.prices);
  allRules.push(...libResult.rules);
  allWarnings.push(...libResult.warnings.map((w) => `[Libres] ${w}`));

  // Dexcom G6/G7
  const dexWs = wb.getWorksheet("G6G7");
  if (!dexWs) {
    throw new Error('Sheet "G6G7" not found in workbook');
  }
  const dexResult = parseDexcom(dexWs);
  allPrices.push(...dexResult.prices);
  allRules.push(...dexResult.rules);
  allWarnings.push(...dexResult.warnings.map((w) => `[G6G7] ${w}`));

  // ---- runtime validation: fail-loud on unknown conditions ----
  const knownSet = new Set<string>(KNOWN_CONDITIONS);
  for (const p of allPrices) {
    if (!knownSet.has(p.condition)) {
      throw new Error(
        `GROUNDING VIOLATION: unknown condition "${p.condition}" on ` +
          `"${p.productName}" (row ${p.sourceRow}, sheet ${p.sourceSheet}). ` +
          `Known conditions: ${[...knownSet].join(", ")}`,
      );
    }
  }

  // ---- rebuild DB inside a transaction ----
  console.log(
    `Importing ${allPrices.length} prices, ${allRules.length} adjustment rules...`,
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fully typed after `prisma generate`
  await prisma.$transaction(async (tx: any) => {
    // Truncate in FK-safe order: prices first (has FK to rules), then rules.
    await tx.basePrice.deleteMany();
    await tx.adjustmentRule.deleteMany();

    // Insert rules first so FK references resolve.
    for (const rule of allRules) {
      await tx.adjustmentRule.create({
        data: {
          scopeKey: rule.scopeKey,
          deltaAmount: rule.deltaAmount,
          note: rule.note,
          sourceSheet: rule.sourceSheet,
        },
      });
    }

    // Insert prices. Batch in chunks for speed.
    const CHUNK = 100;
    for (let i = 0; i < allPrices.length; i += CHUNK) {
      const chunk = allPrices.slice(i, i + CHUNK);
      await tx.basePrice.createMany({
        data: chunk.map((p) => ({
          category: p.category,
          productName: p.productName,
          reference: p.reference,
          condition: p.condition,
          dateFrom: p.dateFrom,
          dateTo: p.dateTo,
          price: p.price,
          dingRuleKey: p.dingRuleKey,
          sourceSheet: p.sourceSheet,
          sourceRow: p.sourceRow,
        })),
      });
    }
  });

  // ---- summary ----
  console.log("\n✓ Import complete.");
  console.log(`  Prices:  ${allPrices.length}`);
  console.log(`  Rules:   ${allRules.length}`);
  console.log(`  Warnings: ${allWarnings.length}`);

  if (allWarnings.length > 0) {
    console.log("\n--- Warnings ---");
    for (const w of allWarnings) {
      console.log(`  ${w}`);
    }
  }
}

main()
  .catch((err) => {
    console.error("Import failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

export {};
