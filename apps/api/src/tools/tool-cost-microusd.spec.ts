import { extractToolGovernableDomain } from "./tool-contract";
import { describe, expect, it } from "vitest";
import { MAX_MICROUSD } from "./microusd";
import {
  noNewMicroToolReplayCost,
  assertToolCostContextCompatible,
  estimatedToolMicrousd,
  observedToolMicrousd,
} from "./tool-cost-microusd";
const cost = (fields: Record<string, unknown> = {}) => ({
  unit: "request" as const,
  estimatedCents: 19,
  external: true,
  ...fields,
});
const result = (fields: Record<string, unknown> = {}) => ({
  costCents: 19,
  ...fields,
});
describe("A08 exact tool-cost bridge", () => {
  it.each([
    ["1780", 1780n],
    ["1700", 1700n],
    ["0", 0n],
    [MAX_MICROUSD.toString(), MAX_MICROUSD],
  ])("uses estimated micro %s exactly", (raw, expected) => {
    expect(
      estimatedToolMicrousd(
        cost({ estimatedMicrousd: raw, estimatedCents: 0.178 }),
      ),
    ).toBe(expected);
  });
  it.each([
    ["1780", 1780n],
    ["1700", 1700n],
    ["0", 0n],
    [MAX_MICROUSD.toString(), MAX_MICROUSD],
  ])("uses observed micro %s exactly", (raw, expected) => {
    expect(
      observedToolMicrousd(result({ costMicrousd: raw, costCents: 0.178 })),
    ).toBe(expected);
  });
  it.each([0, 1, 19])("converts legacy estimated integer cents %s", (cents) => {
    expect(estimatedToolMicrousd(cost({ estimatedCents: cents }))).toBe(
      BigInt(cents) * 10000n,
    );
  });
  it.each([0, 1, 19])("converts legacy observed integer cents %s", (cents) => {
    expect(observedToolMicrousd(result({ costCents: cents }))).toBe(
      BigInt(cents) * 10000n,
    );
  });
  const invalidMicro: unknown[] = [
    "",
    "01",
    "1.0",
    "1e3",
    "-1",
    " 1",
    "1 ",
    "NaN",
    "Infinity",
    null,
    undefined,
    1780,
    (MAX_MICROUSD + 1n).toString(),
  ];
  it.each(invalidMicro)(
    "rejects explicit estimated micro %j without fallback",
    (raw) => {
      expect(() =>
        estimatedToolMicrousd(cost({ estimatedMicrousd: raw })),
      ).toThrow();
    },
  );
  it.each(invalidMicro)(
    "rejects explicit observed micro %j without fallback",
    (raw) => {
      expect(() =>
        observedToolMicrousd(result({ costMicrousd: raw })),
      ).toThrow();
    },
  );
  const invalidLegacy: unknown[] = [
    0.178,
    0.17,
    -1,
    NaN,
    Infinity,
    "1",
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
  ];
  it.each(invalidLegacy)(
    "rejects invalid legacy estimated cents %j",
    (cents) => {
      expect(() =>
        estimatedToolMicrousd(cost({ estimatedCents: cents })),
      ).toThrow();
    },
  );
  it.each(invalidLegacy)(
    "rejects invalid legacy observed cents %j",
    (cents) => {
      expect(() =>
        observedToolMicrousd(result({ costCents: cents })),
      ).toThrow();
    },
  );
});

describe("new micro tool and original Site Builder paidCost separation", () => {
  it("leaves legacy paidCost tools unchanged", () =>
    expect(() =>
      assertToolCostContextCompatible(cost(), { paidCost: {} as never }),
    ).not.toThrow());
  it("allows canonical micro product tools without the separate paidCost namespace", () =>
    expect(() =>
      assertToolCostContextCompatible(
        cost({ estimatedMicrousd: "1780", estimatedCents: 0.178 }),
        {},
      ),
    ).not.toThrow());
  it.each(["1780", undefined, null])(
    "rejects the explicit micro lane in paidCost before parsing or reservation %#",
    (estimatedMicrousd) =>
      expect(() =>
        assertToolCostContextCompatible(cost({ estimatedMicrousd }), {
          paidCost: {} as never,
        }),
      ).toThrow("BUDGET_MICROUSD_PAID_COST_UNSUPPORTED"),
  );
  it("rejects explicit null paidCost on a micro tool rather than falling through", () =>
    expect(() =>
      assertToolCostContextCompatible(cost({ estimatedMicrousd: "1780" }), {
        paidCost: null as never,
      }),
    ).toThrow("BUDGET_MICROUSD_PAID_COST_UNSUPPORTED"));
  it("does not evaluate an explicit micro getter when rejecting the paid namespace", () => {
    const c = cost();
    let reads = 0;
    Object.defineProperty(c, "estimatedMicrousd", {
      enumerable: true,
      get() {
        reads += 1;
        return "1780";
      },
    });
    expect(() =>
      assertToolCostContextCompatible(c, { paidCost: {} as never }),
    ).toThrow("BUDGET_MICROUSD_PAID_COST_UNSUPPORTED");
    expect(reads).toBe(0);
  });
});

describe("micro replay outer cost versus original authoritative receipt", () => {
  it("reports no new charge without altering data, original receipt, or the stored source result", () => {
    const receipt = {
      operationId: "original-op",
      usage: { upperBoundMicrousd: "1780" },
    } as never;
    const raw = {
      data: { reference: "original-result" },
      costCents: 0.178,
      costMicrousd: "1780",
      durableReceipt: receipt,
    };
    const replay = noNewMicroToolReplayCost(raw);
    expect(replay.costCents).toBe(0);
    expect(replay.costMicrousd).toBe("0");
    expect(replay.data).toBe(raw.data);
    expect(replay.durableReceipt).toBe(receipt);
    expect(raw.costMicrousd).toBe("1780");
    expect(raw.costCents).toBe(0.178);
  });
  it("does not reinterpret or rewrite a legacy cent-tool replay", () => {
    const raw = { data: { ok: true }, costCents: 7 };
    expect(noNewMicroToolReplayCost(raw)).toBe(raw);
  });
  it("does not mask an invalid explicit micro result as a free replay", () =>
    expect(() =>
      noNewMicroToolReplayCost({
        data: {},
        costCents: 0.17,
        costMicrousd: "01",
      }),
    ).toThrow());
});
describe("original governable-domain helper extraction retains behavior", () => {
  it.each([
    [{ url: "https://www.example.invalid/path" }, "example.invalid"],
    [{ domain: "www.example.invalid" }, "example.invalid"],
    [{ domain: "api.example.invalid" }, "api.example.invalid"],
    [{}, null],
    [{ url: "https://%zz/" }, null],
    [{ domain: 123 }, null],
  ] as const)("retains original input case %#", (input, domain) =>
    expect(extractToolGovernableDomain(input)).toBe(domain),
  );
});
