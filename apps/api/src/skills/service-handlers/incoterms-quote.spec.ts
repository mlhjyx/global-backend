import { describe, expect, it } from "vitest";
import {
  computeIncotermsQuote,
  INCOTERMS_FORMULA_VERSION,
  QuotingInputError,
  type IncotermsQuoteOutput,
} from "./incoterms-quote";

const BASE_LINES = [
  { kind: "goods", amount: 1000, currency: "USD" },
  { kind: "packaging", amount: 100, currency: "USD" },
  { kind: "inland_freight", amount: 50, currency: "USD" },
  { kind: "ocean_freight", amount: 300, currency: "USD" },
  { kind: "insurance", amount: 20, currency: "USD" },
  { kind: "duty", amount: 80, currency: "USD" },
] as const;

function quote(incoterm: string, extra: Record<string, unknown> = {}): IncotermsQuoteOutput {
  return computeIncotermsQuote({
    incoterm,
    quantity: 10,
    currency: "USD",
    marginPct: 10,
    costLines: BASE_LINES,
    ...extra,
  });
}

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (cause) {
    return cause instanceof QuotingInputError ? cause.code : `UNEXPECTED:${String(cause)}`;
  }
}

describe("computeIncotermsQuote", () => {
  it("charges only the cost lines the incoterm assigns to the seller", () => {
    const exw = quote("EXW");
    expect(exw.breakdown.filter((line) => line.included).map((line) => line.kind)).toEqual([
      "goods",
      "packaging",
    ]);
    expect(exw.unitCost).toBe(110);
    expect(exw.totalUnitPrice).toBe(121);
    expect(exw.totalAmount).toBe(1210);

    const fob = quote("FOB");
    expect(fob.unitCost).toBe(115);
    expect(fob.totalUnitPrice).toBe(126.5);

    const cfr = quote("CFR");
    expect(cfr.unitCost).toBe(145);
    expect(cfr.totalUnitPrice).toBe(159.5);

    const cif = quote("CIF");
    expect(cif.unitCost).toBe(147);
    expect(cif.totalUnitPrice).toBe(161.7);

    const ddp = quote("DDP");
    expect(ddp.unitCost).toBe(155);
    expect(ddp.totalUnitPrice).toBe(170.5);
    expect(ddp.totalAmount).toBe(1705);
  });

  it("converts foreign cost lines with the supplied rate only", () => {
    const out = computeIncotermsQuote({
      incoterm: "EXW",
      quantity: 10,
      currency: "USD",
      exchangeRate: 1.1,
      marginPct: 10,
      costLines: [
        { kind: "goods", amount: 1000, currency: "EUR" },
        { kind: "packaging", amount: 100, currency: "USD" },
      ],
    });
    expect(out.totalUnitPrice).toBe(132);
    expect(out.totalAmount).toBe(1320);
    expect(out.assumptions.some((line) => line.includes("1 EUR = 1.1 USD"))).toBe(true);
  });

  it("fails closed without an exchange rate across currencies", () => {
    expect(
      codeOf(() =>
        computeIncotermsQuote({
          incoterm: "EXW",
          quantity: 1,
          currency: "USD",
          costLines: [{ kind: "goods", amount: 10, currency: "EUR" }],
        }),
      ),
    ).toBe("QUOTING_EXCHANGE_RATE_REQUIRED");
  });

  it("requires an included goods line", () => {
    expect(
      codeOf(() =>
        computeIncotermsQuote({
          incoterm: "EXW",
          quantity: 1,
          currency: "USD",
          costLines: [{ kind: "packaging", amount: 10, currency: "USD" }],
        }),
      ),
    ).toBe("QUOTING_GOODS_REQUIRED");
  });

  it("rejects malformed inputs", () => {
    expect(codeOf(() => computeIncotermsQuote({ ...quoteInput(), incoterm: "FCA" }))).toBe(
      "QUOTING_INCOTERM_INVALID",
    );
    expect(codeOf(() => computeIncotermsQuote({ ...quoteInput(), quantity: 0 }))).toBe(
      "QUOTING_QUANTITY_INVALID",
    );
    expect(codeOf(() => computeIncotermsQuote({ ...quoteInput(), currency: "usd" }))).toBe(
      "QUOTING_CURRENCY_INVALID",
    );
    expect(codeOf(() => computeIncotermsQuote({ ...quoteInput(), marginPct: 400 }))).toBe(
      "QUOTING_MARGIN_INVALID",
    );
    expect(codeOf(() => computeIncotermsQuote({ ...quoteInput(), costLines: [] }))).toBe(
      "QUOTING_COST_LINES_INVALID",
    );
    expect(
      codeOf(() =>
        computeIncotermsQuote({
          ...quoteInput(),
          costLines: [{ kind: "goods", amount: -1, currency: "USD" }],
        }),
      ),
    ).toBe("QUOTING_COST_LINES_INVALID");
  });

  it("keeps the cent-integer rounding deterministic", () => {
    const out = computeIncotermsQuote({
      incoterm: "EXW",
      quantity: 3,
      currency: "USD",
      marginPct: 7.5,
      costLines: [{ kind: "goods", amount: 10, currency: "USD" }],
    });
    // 10 / 3 = 3.3333… → *1.075 = 3.5833… → 3.58；3.58 * 3 = 10.74
    expect(out.unitCost).toBeCloseTo(3.3333333333333335, 12);
    expect(out.totalUnitPrice).toBe(3.58);
    expect(out.totalAmount).toBe(10.74);
    expect(out.formulaVersion).toBe(INCOTERMS_FORMULA_VERSION);
  });

  it("never emits document fields (L1 red line: no PI/CI/PL)", () => {
    const out = quote("DDP") as unknown as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual([
      "assumptions",
      "breakdown",
      "currency",
      "formulaVersion",
      "incoterm",
      "totalAmount",
      "totalUnitPrice",
      "unitCost",
      "warnings",
    ]);
    for (const key of Object.keys(out)) {
      expect(key).not.toMatch(/proforma|invoice|packing|document|pdf/iu);
    }
  });
});

function quoteInput(): Record<string, unknown> {
  return {
    incoterm: "EXW",
    quantity: 10,
    currency: "USD",
    marginPct: 10,
    costLines: [{ kind: "goods", amount: 100, currency: "USD" }],
  };
}
