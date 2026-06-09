/**
 * PDF quote generator.
 *
 * Produces a clean, professional quote document from the engine results.
 * Returns a Buffer that the bot sends as a Telegram document.
 *
 * The PDF contains only grounded data: product names, conditions, quantities,
 * and the exact prices computed by the engine (with provenance IDs for audit).
 */

import PDFDocument from "pdfkit";
import type { QuoteItem } from "./handler.js";

export interface QuoteData {
  quoteNumber: string;
  date: string; // formatted date string
  items: QuoteItem[];
  grandTotal: number | null; // null if any item has no quantity
}

/** Generate a quote number from the current timestamp. */
export function generateQuoteNumber(): string {
  const now = new Date();
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("");
  const suffix = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `MAXMED-${date}-${suffix}`;
}

/** Generate the PDF quote and return it as a Buffer. */
export async function generateQuotePDF(data: QuoteData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "LETTER",
        margins: { top: 50, bottom: 50, left: 50, right: 50 },
      });

      const chunks: Buffer[] = [];
      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const pageWidth = doc.page.width - 100; // accounting for margins

      // ---- header ----
      doc.fontSize(22).font("Helvetica-Bold").text("MAXMED Distributors", {
        align: "center",
      });
      doc.fontSize(10).font("Helvetica").text("Diabetic Supply Buyer", {
        align: "center",
      });
      doc.moveDown(1.5);

      // ---- quote info ----
      doc.fontSize(14).font("Helvetica-Bold").text("PURCHASE QUOTE");
      doc.moveDown(0.3);

      doc
        .fontSize(10)
        .font("Helvetica")
        .text(`Quote #: ${data.quoteNumber}`)
        .text(`Date: ${data.date}`);
      doc.moveDown(1);

      // ---- horizontal rule ----
      const lineY = doc.y;
      doc
        .moveTo(50, lineY)
        .lineTo(50 + pageWidth, lineY)
        .strokeColor("#333333")
        .lineWidth(1)
        .stroke();
      doc.moveDown(0.8);

      // ---- items table ----
      const col = {
        product: 50,
        condition: 260,
        qty: 340,
        unit: 400,
        total: 470,
      };

      // Table header
      doc.fontSize(9).font("Helvetica-Bold");
      doc.text("Product", col.product, doc.y, { continued: false });
      const headerY = doc.y - doc.currentLineHeight();
      doc.text("Condition", col.condition, headerY);
      doc.text("Qty", col.qty, headerY);
      doc.text("Unit Price", col.unit, headerY);
      doc.text("Total", col.total, headerY);
      doc.moveDown(0.3);

      // Header underline
      const hLineY = doc.y;
      doc
        .moveTo(50, hLineY)
        .lineTo(50 + pageWidth, hLineY)
        .strokeColor("#999999")
        .lineWidth(0.5)
        .stroke();
      doc.moveDown(0.4);

      // Table rows
      doc.fontSize(9).font("Helvetica");

      for (const item of data.items) {
        const label = item.reference
          ? `${item.productName} (${item.reference})`
          : item.productName;
        const condLabel = item.condition.replace("_", " ");
        const qtyStr = item.quantity !== null ? String(item.quantity) : "—";
        const unitStr = `$${item.unitPrice.toFixed(2)}`;
        const totalStr =
          item.totalPrice !== null ? `$${item.totalPrice.toFixed(2)}` : "—";

        const rowY = doc.y;
        doc.text(label, col.product, rowY, { width: 200 });
        // After multi-line product name, get the actual bottom Y
        const afterProductY = doc.y;
        doc.text(condLabel, col.condition, rowY);
        doc.text(qtyStr, col.qty, rowY);
        doc.text(unitStr, col.unit, rowY);
        doc.text(totalStr, col.total, rowY);

        // Move to whichever was lower (product name can wrap)
        doc.y = Math.max(afterProductY, doc.y);
        doc.moveDown(0.3);
      }

      // ---- grand total ----
      doc.moveDown(0.5);
      const totalLineY = doc.y;
      doc
        .moveTo(col.unit - 10, totalLineY)
        .lineTo(50 + pageWidth, totalLineY)
        .strokeColor("#333333")
        .lineWidth(1)
        .stroke();
      doc.moveDown(0.4);

      doc.fontSize(11).font("Helvetica-Bold");
      if (data.grandTotal !== null) {
        doc.text(`Grand Total: $${data.grandTotal.toFixed(2)}`, col.unit - 10, doc.y, {
          align: "right",
          width: pageWidth - (col.unit - 10) + 50,
        });
      } else {
        doc.text("Total: per-unit pricing (quantities not specified)", col.product, doc.y);
      }

      // ---- terms ----
      doc.moveDown(2);
      const termsY = doc.y;
      doc
        .moveTo(50, termsY)
        .lineTo(50 + pageWidth, termsY)
        .strokeColor("#999999")
        .lineWidth(0.5)
        .stroke();
      doc.moveDown(0.5);

      doc.fontSize(8).font("Helvetica").fillColor("#666666");
      doc.text(
        "• Prices are per box/pack and subject to physical inspection of the supplies.",
        50,
        doc.y,
        { width: pageWidth },
      );
      doc.text(
        "• This quote is valid for 7 days from the date above.",
        { width: pageWidth },
      );
      doc.text(
        "• Final payment is issued after receipt and verification of all items.",
        { width: pageWidth },
      );

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/** Build QuoteData from handler results. */
export function buildQuoteData(items: QuoteItem[]): QuoteData {
  const quoteNumber = generateQuoteNumber();
  const now = new Date();
  const date = now.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  let grandTotal: number | null = 0;
  for (const item of items) {
    if (item.totalPrice === null) {
      grandTotal = null;
      break;
    }
    grandTotal += item.totalPrice;
  }

  return { quoteNumber, date, items, grandTotal };
}
