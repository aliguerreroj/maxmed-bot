import { describe, it, expect } from "vitest";
import { parseDateTier, classifyColumn, monthStart, monthEnd } from "../src/parsers/dates.js";

describe("parseDateTier", () => {
  it("parses open-ended plus tier: 4/2027+", () => {
    const r = parseDateTier("4/2027+");
    expect(r).not.toBeNull();
    expect(r!.from).toEqual(new Date(Date.UTC(2027, 3, 1)));
    expect(r!.to).toBeNull();
  });

  it("parses single-month tier: 11/2026", () => {
    const r = parseDateTier("11/2026");
    expect(r).not.toBeNull();
    expect(r!.from).toEqual(new Date(Date.UTC(2026, 10, 1)));
    expect(r!.to).toEqual(new Date(Date.UTC(2026, 10, 30)));
  });

  it("parses reversed range: 3/2027-12/2026 → Dec 2026–Mar 2027", () => {
    const r = parseDateTier("3/2027-12/2026");
    expect(r).not.toBeNull();
    expect(r!.from).toEqual(new Date(Date.UTC(2026, 11, 1))); // Dec 1 2026
    expect(r!.to).toEqual(new Date(Date.UTC(2027, 2, 31))); // Mar 31 2027
  });

  it("parses a normal-order range: 1/2026-3/2026", () => {
    const r = parseDateTier("1/2026-3/2026");
    expect(r).not.toBeNull();
    expect(r!.from).toEqual(new Date(Date.UTC(2026, 0, 1)));
    expect(r!.to).toEqual(new Date(Date.UTC(2026, 2, 31)));
  });

  it("returns null for non-date labels", () => {
    expect(parseDateTier("PRODUCT")).toBeNull();
    expect(parseDateTier("DING")).toBeNull();
    expect(parseDateTier("N/A")).toBeNull();
    expect(parseDateTier("")).toBeNull();
    expect(parseDateTier("Expires (stuff)")).toBeNull();
  });
});

describe("monthStart / monthEnd", () => {
  it("Feb 2026 ends on the 28th (non-leap)", () => {
    expect(monthEnd(2026, 2).getUTCDate()).toBe(28);
  });

  it("Feb 2028 ends on the 29th (leap)", () => {
    expect(monthEnd(2028, 2).getUTCDate()).toBe(29);
  });
});

describe("classifyColumn", () => {
  it("PRODUCT → product", () => {
    expect(classifyColumn("PRODUCT").role).toBe("product");
  });

  it("date tier → mintTier with range", () => {
    const r = classifyColumn("6/2027+");
    expect(r.role).toBe("mintTier");
    if (r.role === "mintTier") {
      expect(r.range.from).toEqual(new Date(Date.UTC(2027, 5, 1)));
      expect(r.range.to).toBeNull();
    }
  });

  it("DING → ding", () => {
    expect(classifyColumn("DING").role).toBe("ding");
  });

  it("Acceptable Damage → damaged", () => {
    expect(classifyColumn("Acceptable Damage").role).toBe("damaged");
  });

  it("Short Dates → shortDate", () => {
    expect(classifyColumn("Short Dates").role).toBe("shortDate");
  });

  it("Expires (long text) → expired", () => {
    const r = classifyColumn(
      "Expires (Minor Damage ok, boxes sealed, lot numbers and exp dates visible. Expired Test Strips 6 Months Back Max)",
    );
    expect(r.role).toBe("expired");
  });

  it("empty → ignore", () => {
    expect(classifyColumn("").role).toBe("ignore");
  });

  it("REFERENCE → reference", () => {
    expect(classifyColumn("REFERENCE").role).toBe("reference");
  });
});
