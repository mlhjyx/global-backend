import { describe, expect, it } from "vitest";
import {
  DISCOVERY_QUERY_RECEIPT_MAX_ENTRIES,
  discoveryQueryKey,
  mergeDiscoveryQueryReceipt,
  parseDiscoveryQueryReceipt,
  readDiscoveryQueryReceipt,
  summarizeDiscoveryQueryReceipts,
} from "./discovery-query-receipt";

const RUN = "40000000-0000-4000-8000-000000000001";
const PLAN = "50000000-0000-4000-8000-000000000001";

function receipt(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: "discovery-query-receipt/v1",
    queryKey: "a".repeat(64),
    queryOrdinal: 0,
    sourceClass: "public_intelligence",
    providers: ["ted"],
    accepted: 1,
    quarantined: 0,
    rejected: 0,
    governanceDenied: 0,
    duplicate: 0,
    usageQuantity: 1,
    costCents: 0,
    ...overrides,
  };
}

describe("durable Discovery query receipts", () => {
  it("derives one opaque key from the canonical run/plan/ordinal/normalized-query identity", () => {
    const left = discoveryQueryKey({
      runId: RUN,
      planId: PLAN,
      queryOrdinal: 2,
      query: {
        source_class: "public_intelligence",
        filters: { source_hint: "ted", nested: { country: "DE" } },
        keywords: ["pump", "valve"],
        priority: 1,
      },
    });
    const reordered = discoveryQueryKey({
      runId: RUN,
      planId: PLAN,
      queryOrdinal: 2,
      query: {
        priority: 1,
        keywords: ["pump", "valve"],
        filters: { nested: { country: "DE" }, source_hint: "ted" },
        source_class: "public_intelligence",
      },
    });

    expect(left).toMatch(/^[0-9a-f]{64}$/u);
    expect(reordered).toBe(left);
    expect(
      discoveryQueryKey({
        runId: RUN,
        planId: PLAN,
        queryOrdinal: 3,
        query: {
          source_class: "public_intelligence",
          filters: { source_hint: "ted", nested: { country: "DE" } },
          keywords: ["pump", "valve"],
          priority: 1,
        },
      }),
    ).not.toBe(left);
  });

  it("stores only bounded non-payload metadata and returns an exact immutable readback", () => {
    const source = receipt();
    const stats = mergeDiscoveryQueryReceipt({ keep: { fit: 1 } }, source);
    const stored = readDiscoveryQueryReceipt(stats, "a".repeat(64));

    expect(stored).toEqual(source);
    expect(stats).toMatchObject({ keep: { fit: 1 } });
    expect(JSON.stringify(stored)).not.toMatch(
      /normalizedQuery|keywords|filters|payload|externalId|rawId|secret|person@example/u,
    );
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored?.providers)).toBe(true);
  });

  it("accepts exact replay but rejects receipt drift and a second fingerprint for one ordinal", () => {
    const first = receipt();
    const stats = mergeDiscoveryQueryReceipt({}, first);

    expect(mergeDiscoveryQueryReceipt(stats, first)).toEqual(stats);
    expect(() =>
      mergeDiscoveryQueryReceipt(stats, receipt({ accepted: 2, usageQuantity: 2 })),
    ).toThrow("DISCOVERY_QUERY_RECEIPT_DRIFT");
    expect(() =>
      mergeDiscoveryQueryReceipt(
        stats,
        receipt({ queryKey: "b".repeat(64), queryOrdinal: 0 }),
      ),
    ).toThrow("DISCOVERY_QUERY_RECEIPT_ORDINAL_CONFLICT");
  });

  it.each([
    ["extra key", { extra: "forged" }],
    ["non-opaque key", { queryKey: "query:ted:pump" }],
    ["negative count", { accepted: -1 }],
    ["oversized count", { duplicate: 1_000_001 }],
    ["governance mismatch", { quarantined: 1, governanceDenied: 0 }],
    ["usage mismatch", { accepted: 2, usageQuantity: 1 }],
    ["unsafe provider", { providers: ["person@example.test"] }],
    ["too many providers", { providers: Array.from({ length: 17 }, (_, i) => `provider_${i}`) }],
    ["unbounded cost", { costCents: 1_000_000_001 }],
  ])("rejects a malformed or forged receipt: %s", (_label, forged) => {
    expect(() => parseDiscoveryQueryReceipt(receipt(forged))).toThrow(
      /DISCOVERY_QUERY_RECEIPT_INVALID/u,
    );
  });

  it("bounds the receipt store by entry count", () => {
    let stats: Record<string, unknown> = {};
    for (let index = 0; index < DISCOVERY_QUERY_RECEIPT_MAX_ENTRIES; index += 1) {
      stats = mergeDiscoveryQueryReceipt(
        stats,
        receipt({
          queryKey: index.toString(16).padStart(64, "0"),
          queryOrdinal: index,
        }),
      );
    }
    expect(() =>
      mergeDiscoveryQueryReceipt(
        stats,
        receipt({
          queryKey: "f".repeat(64),
          queryOrdinal: DISCOVERY_QUERY_RECEIPT_MAX_ENTRIES,
        }),
      ),
    ).toThrow("DISCOVERY_QUERY_RECEIPT_STORE_LIMIT");
  });

  it("derives exact per-query, per-source, and total governance accounting", () => {
    const first = receipt();
    const second = receipt({
      queryKey: "b".repeat(64),
      queryOrdinal: 1,
      providers: ["openfda"],
      accepted: 0,
      quarantined: 2,
      rejected: 1,
      governanceDenied: 3,
      duplicate: 4,
      usageQuantity: 0,
      costCents: 7,
    });
    const stats = mergeDiscoveryQueryReceipt(
      mergeDiscoveryQueryReceipt({}, first),
      second,
    );

    expect(summarizeDiscoveryQueryReceipts(stats)).toEqual({
      perQuery: {
        ["a".repeat(64)]: first,
        ["b".repeat(64)]: second,
      },
      perSource: {
        public_intelligence: {
          rawCount: 1,
          quarantinedCount: 2,
          rejectedCount: 1,
          governanceDenied: 3,
          duplicateCount: 4,
          usageQuantity: 1,
          costCents: 7,
          providers: ["openfda", "ted"],
        },
      },
      rawGovernance: {
        accepted: 1,
        quarantined: 2,
        rejected: 1,
        governanceDenied: 3,
        duplicate: 4,
        usageQuantity: 1,
        costCents: 7,
      },
    });
  });
});
