/**
 * Prisma queries that feed the engine.
 * Converts Prisma Decimal → number and shapes rows into the engine's PriceRow type.
 */

import type { PrismaClient } from "@prisma/client";
import type { PriceRow, DingRule } from "./types.js";

/** Fetch all BasePrice rows for a specific (category, productName, reference). */
export async function queryProductPrices(
  db: PrismaClient,
  category: string,
  productName: string,
  reference: string | null,
): Promise<PriceRow[]> {
  const rows = await db.basePrice.findMany({
    where: { category, productName, reference },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fully typed after `prisma generate`
  return rows.map((r: any) => ({
    id: r.id,
    category: r.category,
    productName: r.productName,
    reference: r.reference,
    condition: r.condition,
    dateFrom: r.dateFrom,
    dateTo: r.dateTo,
    price: Number(r.price),
    dingRuleKey: r.dingRuleKey,
  }));
}

/** Load all AdjustmentRules once (there are ~5). Cache at startup. */
export async function loadAllRules(
  db: PrismaClient,
): Promise<Map<string, DingRule>> {
  const rules = await db.adjustmentRule.findMany();
  return new Map(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fully typed after `prisma generate`
    rules.map((r: any) => [
      r.scopeKey,
      {
        id: r.id,
        scopeKey: r.scopeKey,
        deltaAmount: Number(r.deltaAmount),
      },
    ]),
  );
}

/** Fetch the distinct product catalog for the extraction prompt. */
export async function loadProductCatalog(
  db: PrismaClient,
): Promise<Array<{ category: string; productName: string; reference: string | null }>> {
  const rows = await db.basePrice.findMany({
    select: { category: true, productName: true, reference: true },
    distinct: ["category", "productName", "reference"],
    orderBy: [{ category: "asc" }, { productName: "asc" }],
  });
  return rows;
}
