/**
 * Builds a product catalog string for the extraction LLM prompt.
 *
 * CRITICAL: this includes product names and references ONLY — never prices.
 * The LLM must never see a price, ensuring it cannot hallucinate one.
 */

interface CatalogEntry {
  category: string;
  productName: string;
  reference: string | null;
}

const CATEGORY_LABELS: Record<string, string> = {
  test_strips: "TEST STRIPS",
  libre: "LIBRE (Freestyle Libre CGM)",
  dexcom_g6: "DEXCOM G6",
  dexcom_g7: "DEXCOM G7",
};

export function buildCatalogPrompt(entries: CatalogEntry[]): string {
  // Group by category
  const grouped = new Map<string, CatalogEntry[]>();
  for (const e of entries) {
    const list = grouped.get(e.category) ?? [];
    list.push(e);
    grouped.set(e.category, list);
  }

  const sections: string[] = [];

  for (const [category, items] of grouped) {
    const label = CATEGORY_LABELS[category] ?? category;
    const lines: string[] = [`${label} (category: "${category}"):`];

    // Group by productName to show references together
    const byProduct = new Map<string, string[]>();
    for (const item of items) {
      const refs = byProduct.get(item.productName) ?? [];
      if (item.reference) refs.push(item.reference);
      byProduct.set(item.productName, refs);
    }

    for (const [name, refs] of byProduct) {
      if (refs.length > 0) {
        lines.push(`  - "${name}" (references: ${refs.map((r) => `"${r}"`).join(", ")})`);
      } else {
        lines.push(`  - "${name}"`);
      }
    }

    sections.push(lines.join("\n"));
  }

  return sections.join("\n\n");
}
