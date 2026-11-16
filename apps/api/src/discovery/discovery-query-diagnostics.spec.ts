import { describe, expect, it } from "vitest";
import type { DiscoveryQueryReceipt } from "./discovery-query-receipt";
import { parseDiscoveryQueryReceipt } from "./discovery-query-receipt";
import { mergeDiscoveryQueryDiagnostics } from "./discovery-query-diagnostics";

type SettledItem = { key: string; r: { outcome?: unknown } };
type Settled = readonly PromiseSettledResult<SettledItem>[];

type StoredProvider = {
  providerKey: string;
  errorClass: string;
  reasonCode: string;
};

type StoredEntry = {
  queryKey: string;
  queryOrdinal: number;
  sourceClass: string;
  providers: StoredProvider[];
};

function key(n: number): string {
  return n.toString(16).padStart(64, "0");
}

function makeReceipt(overrides: Record<string, unknown> = {}): DiscoveryQueryReceipt {
  return parseDiscoveryQueryReceipt({
    schemaVersion: "discovery-query-receipt/v1",
    queryKey: key(1),
    queryOrdinal: 0,
    sourceClass: "company_registry",
    providers: ["registry_frame"],
    accepted: 0,
    quarantined: 0,
    rejected: 0,
    governanceDenied: 0,
    duplicate: 0,
    usageQuantity: 0,
    costCents: 0,
    ...overrides,
  });
}

function fulfilled(providerKey: string, outcome?: unknown): PromiseSettledResult<SettledItem> {
  return {
    status: "fulfilled",
    value: { key: providerKey, r: outcome === undefined ? {} : { outcome } },
  };
}

function rejectedItem(): PromiseSettledResult<SettledItem> {
  return { status: "rejected", reason: new Error("provider failed") };
}

function storedProvider(
  providerKey: string,
  errorClass = "PARAM_INVALID",
  reasonCode = "COUNTRY_INVALID",
): StoredProvider {
  return { providerKey, errorClass, reasonCode };
}

function storedEntry(
  queryOrdinal: number,
  overrides: Partial<StoredEntry> = {},
): StoredEntry {
  return {
    queryKey: key(queryOrdinal + 16),
    queryOrdinal,
    sourceClass: "company_registry",
    providers: [storedProvider("registry_frame")],
    ...overrides,
  };
}

function statsWith(entries: readonly StoredEntry[], extra: Record<string, unknown> = {}) {
  return { ...extra, queryDiagnostics: { version: 1, entries } };
}

function namespaceBytes(entries: readonly StoredEntry[]): number {
  return Buffer.byteLength(JSON.stringify({ version: 1, entries }), "utf8");
}

function merge(
  stats: unknown,
  receipt: DiscoveryQueryReceipt,
  settled: Settled,
): Record<string, unknown> {
  return mergeDiscoveryQueryDiagnostics(stats, receipt, settled);
}

describe("mergeDiscoveryQueryDiagnostics", () => {
  it("projects_only_explicit_allowlisted_outcomes", () => {
    const receipt = makeReceipt({ providers: ["registry_frame", "wikidata_frame"] });
    const result = merge({}, receipt, [
      fulfilled("registry_frame", {
        errorClass: "PARAM_INVALID",
        reasonCode: "COUNTRY_INVALID",
      }),
      fulfilled("wikidata_frame", {
        errorClass: "EMPTY_RESULT",
        reasonCode: "NO_ROWS",
      }),
    ]);
    expect(result.queryDiagnostics).toEqual({
      version: 1,
      entries: [
        {
          queryKey: receipt.queryKey,
          queryOrdinal: 0,
          sourceClass: "company_registry",
          providers: [
            { providerKey: "registry_frame", errorClass: "PARAM_INVALID", reasonCode: "COUNTRY_INVALID" },
            { providerKey: "wikidata_frame", errorClass: "EMPTY_RESULT", reasonCode: "NO_ROWS" },
          ],
        },
      ],
    });
    // Fixed construction field order, ASCII provider ordering, three provider keys only.
    expect(JSON.stringify(result.queryDiagnostics)).toBe(
      `{"version":1,"entries":[{"queryKey":"${receipt.queryKey}","queryOrdinal":0,` +
        `"sourceClass":"company_registry","providers":[` +
        `{"providerKey":"registry_frame","errorClass":"PARAM_INVALID","reasonCode":"COUNTRY_INVALID"},` +
        `{"providerKey":"wikidata_frame","errorClass":"EMPTY_RESULT","reasonCode":"NO_ROWS"}]}]}`,
    );
  });

  it("absence_and_rejection_remain_unknown", () => {
    const receipt = makeReceipt();
    const base = { perQuery: { [receipt.queryKey]: {} }, keep: "value" };

    // Spec matrix: no outcome, rejected, unknown class/reason, invalid combo, zero records.
    const cases: Settled[] = [
      [fulfilled("registry_frame")],
      [rejectedItem()],
      [fulfilled("registry_frame", { errorClass: "UNKNOWN", reasonCode: "NO_ROWS" })],
      [fulfilled("registry_frame", { errorClass: "PARAM_INVALID", reasonCode: "OTHER" })],
      [fulfilled("registry_frame", { errorClass: "PARAM_INVALID", reasonCode: "NO_ROWS" })],
      [fulfilled("registry_frame", { errorClass: "EMPTY_RESULT", reasonCode: "COUNTRY_INVALID" })],
      [fulfilled("registry_frame", { outcome: null })],
      [fulfilled("registry_frame", "PARAM_INVALID")],
      // Zero records alone never derives NO_ROWS: the helper reads only `outcome`.
      [
        {
          status: "fulfilled",
          value: { key: "registry_frame", r: { records: [], costCents: 0 } },
        } as PromiseSettledResult<SettledItem>,
      ],
    ];
    for (const settled of cases) {
      const result = merge(base, receipt, settled);
      expect(result.queryDiagnostics).toBeUndefined();
      expect(result).toBe(base);
    }
  });

  it("never_serializes_issues_or_query_values", () => {
    const sentinel = "SENTINEL-DO-NOT-PERSIST";
    const result = merge(
      { keep: sentinel } as Record<string, unknown>,
      makeReceipt(),
      [
        fulfilled("registry_frame", {
          errorClass: "PARAM_INVALID",
          reasonCode: "COUNTRY_INVALID",
          issues: [sentinel],
          detail: sentinel,
          filters: { country: [sentinel] },
          keywords: [sentinel],
        }),
      ],
    );
    const serialized = JSON.stringify(result.queryDiagnostics);
    expect(serialized).not.toContain(sentinel);
    expect(result.queryDiagnostics).toEqual({
      version: 1,
      entries: [
        {
          queryKey: key(1),
          queryOrdinal: 0,
          sourceClass: "company_registry",
          providers: [
            { providerKey: "registry_frame", errorClass: "PARAM_INVALID", reasonCode: "COUNTRY_INVALID" },
          ],
        },
      ],
    });
    for (const entry of (result.queryDiagnostics as { entries: StoredEntry[] }).entries) {
      expect(Object.keys(entry)).toEqual(["queryKey", "queryOrdinal", "sourceClass", "providers"]);
      for (const provider of entry.providers) {
        expect(Object.keys(provider)).toEqual(["providerKey", "errorClass", "reasonCode"]);
      }
    }
  });

  it("uses_receipt_identity_only", () => {
    const receipt = makeReceipt({
      queryKey: key(7),
      queryOrdinal: 2,
      sourceClass: "industry_data",
      providers: ["registry_frame"],
    });
    const result = merge({}, receipt, [
      // Provider outside the receipt's provider list can never become an identity.
      fulfilled("other_provider", { errorClass: "EMPTY_RESULT", reasonCode: "NO_ROWS" }),
      // Unsafe/oversized settled keys are ignored even if they echo a valid outcome.
      fulfilled("Bad Key!", { errorClass: "EMPTY_RESULT", reasonCode: "NO_ROWS" }),
      fulfilled("x".repeat(65), { errorClass: "EMPTY_RESULT", reasonCode: "NO_ROWS" }),
      fulfilled("registry_frame", { errorClass: "EMPTY_RESULT", reasonCode: "NO_ROWS" }),
    ]);
    expect(result.queryDiagnostics).toEqual({
      version: 1,
      entries: [
        {
          queryKey: key(7),
          queryOrdinal: 2,
          sourceClass: "industry_data",
          providers: [
            { providerKey: "registry_frame", errorClass: "EMPTY_RESULT", reasonCode: "NO_ROWS" },
          ],
        },
      ],
    });
  });

  it("same_entry_is_idempotent", () => {
    const receipt = makeReceipt();
    const settled: Settled = [
      fulfilled("registry_frame", { errorClass: "PARAM_INVALID", reasonCode: "COUNTRY_INVALID" }),
    ];
    const first = merge({}, receipt, settled);
    const second = merge(first, receipt, settled);
    expect(second).toBe(first);
    expect(second.queryDiagnostics).toEqual(first.queryDiagnostics);
  });

  it("rejects_key_ordinal_or_provider_conflict", () => {
    const receipt = makeReceipt({ queryKey: key(1), queryOrdinal: 3 });
    const emptyDiagnostic = { providerKey: "registry_frame", errorClass: "EMPTY_RESULT", reasonCode: "NO_ROWS" };

    // Same key, different ordinal.
    expect(() =>
      merge(statsWith([storedEntry(0, { queryKey: key(1) })]), receipt, [
        fulfilled("registry_frame", { errorClass: "EMPTY_RESULT", reasonCode: "NO_ROWS" }),
      ]),
    ).toThrow("DISCOVERY_QUERY_RECEIPT_STORE_DIAGNOSTICS_CONFLICT");

    // Same key and ordinal, providers identical, source class different.
    expect(() =>
      merge(
        statsWith([
          storedEntry(3, {
            queryKey: key(1),
            sourceClass: "public_intelligence",
            providers: [emptyDiagnostic],
          }),
        ]),
        receipt,
        [fulfilled("registry_frame", { errorClass: "EMPTY_RESULT", reasonCode: "NO_ROWS" })],
      ),
    ).toThrow("DISCOVERY_QUERY_RECEIPT_STORE_DIAGNOSTICS_CONFLICT");

    // Same key and ordinal, source class identical, provider diagnostics different (no silent union).
    expect(() =>
      merge(statsWith([storedEntry(3, { queryKey: key(1) })]), receipt, [
        fulfilled("registry_frame", { errorClass: "EMPTY_RESULT", reasonCode: "NO_ROWS" }),
      ]),
    ).toThrow("DISCOVERY_QUERY_RECEIPT_STORE_DIAGNOSTICS_CONFLICT");

    // Same ordinal under a different key.
    expect(() =>
      merge(statsWith([storedEntry(3, { queryKey: key(9) })]), receipt, [
        fulfilled("registry_frame", { errorClass: "EMPTY_RESULT", reasonCode: "NO_ROWS" }),
      ]),
    ).toThrow("DISCOVERY_QUERY_RECEIPT_STORE_DIAGNOSTICS_CONFLICT");

    // Identical stored entry merges as a no-op, not a conflict.
    const existing = statsWith([
      storedEntry(3, { queryKey: key(1), providers: [emptyDiagnostic] }),
    ]);
    expect(
      merge(existing, receipt, [
        fulfilled("registry_frame", { errorClass: "EMPTY_RESULT", reasonCode: "NO_ROWS" }),
      ]),
    ).toBe(existing);
  });

  it("enforces_exact_store_and_provider_bounds", () => {
    // 128 entries accepted; a 129th distinct entry is a limit error.
    const full = Array.from({ length: 128 }, (_, index) => storedEntry(index));
    expect(namespaceBytes(full)).toBeLessThanOrEqual(65536);
    const nextReceipt = makeReceipt({ queryKey: key(500), queryOrdinal: 500, providers: ["registry_frame"] });
    expect(() =>
      merge(statsWith(full), nextReceipt, [
        fulfilled("registry_frame", { errorClass: "EMPTY_RESULT", reasonCode: "NO_ROWS" }),
      ]),
    ).toThrow("DISCOVERY_QUERY_RECEIPT_STORE_DIAGNOSTICS_LIMIT");
    // An already oversized entry list is also a limit error.
    expect(() =>
      merge(statsWith([...full, storedEntry(128, { queryKey: key(600) })]), nextReceipt, [
        fulfilled("registry_frame", { errorClass: "EMPTY_RESULT", reasonCode: "NO_ROWS" }),
      ]),
    ).toThrow("DISCOVERY_QUERY_RECEIPT_STORE_DIAGNOSTICS_LIMIT");

    // Provider cardinality: 16 valid diagnostics stay within an entry; 17 stored providers are invalid.
    const sixteen = makeReceipt({
      providers: Array.from({ length: 16 }, (_, index) => `provider_${String(index).padStart(2, "0")}`),
    });
    const sixteenOutcome: Settled = sixteen.providers.map((provider) =>
      fulfilled(provider, { errorClass: "EMPTY_RESULT", reasonCode: "NO_ROWS" }),
    );
    expect(
      (merge({}, sixteen, sixteenOutcome).queryDiagnostics as { entries: StoredEntry[] }).entries[0]!.providers,
    ).toHaveLength(16);
    expect(() =>
      merge(
        statsWith([
          storedEntry(0, {
            providers: Array.from({ length: 17 }, (_, index) =>
              storedProvider(`provider_${String(index).padStart(2, "0")}`),
            ),
          }),
        ]),
        nextReceipt,
        [fulfilled("registry_frame", { errorClass: "EMPTY_RESULT", reasonCode: "NO_ROWS" })],
      ),
    ).toThrow("DISCOVERY_QUERY_RECEIPT_STORE_DIAGNOSTICS_INVALID");

    // Ordinal bounds: 1023 is storable; 1024 stored or forged is invalid.
    const atMax = makeReceipt({ queryKey: key(1023), queryOrdinal: 1023 });
    expect(
      merge({}, atMax, [
        fulfilled("registry_frame", { errorClass: "EMPTY_RESULT", reasonCode: "NO_ROWS" }),
      ]).queryDiagnostics,
    ).toBeDefined();
    expect(() =>
      merge(statsWith([storedEntry(1024, { queryKey: key(1024) })]), nextReceipt, [
        fulfilled("registry_frame", { errorClass: "EMPTY_RESULT", reasonCode: "NO_ROWS" }),
      ]),
    ).toThrow("DISCOVERY_QUERY_RECEIPT_STORE_DIAGNOSTICS_INVALID");
    const forgedOrdinal = { ...atMax, queryOrdinal: 1024 } as DiscoveryQueryReceipt;
    expect(() =>
      merge({}, forgedOrdinal, [
        fulfilled("registry_frame", { errorClass: "EMPTY_RESULT", reasonCode: "NO_ROWS" }),
      ]),
    ).toThrow("DISCOVERY_QUERY_RECEIPT_STORE_DIAGNOSTICS_INVALID");

    // Identifier bounds: a 64-char provider key is storable; 65 chars are invalid.
    const at64 = "p".repeat(64);
    expect(
      merge(
        statsWith([storedEntry(0, { providers: [storedProvider(at64)] })]),
        makeReceipt({ queryOrdinal: 900, queryKey: key(900), providers: [at64] }),
        [fulfilled(at64, { errorClass: "EMPTY_RESULT", reasonCode: "NO_ROWS" })],
      ).queryDiagnostics,
    ).toBeDefined();
    expect(() =>
      merge(
        statsWith([storedEntry(0, { providers: [storedProvider("p".repeat(65))] })]),
        nextReceipt,
        [fulfilled("registry_frame", { errorClass: "EMPTY_RESULT", reasonCode: "NO_ROWS" })],
      ),
    ).toThrow("DISCOVERY_QUERY_RECEIPT_STORE_DIAGNOSTICS_INVALID");

    // Malformed and unknown-version stores are invalid, never repaired.
    for (const broken of [
      { queryDiagnostics: { version: 2, entries: [] } },
      { queryDiagnostics: { version: 1, entries: "nope" } },
      { queryDiagnostics: ["nope"] },
      { queryDiagnostics: { entries: [] } },
    ]) {
      expect(() =>
        merge(broken, nextReceipt, [
          fulfilled("registry_frame", { errorClass: "EMPTY_RESULT", reasonCode: "NO_ROWS" }),
        ]),
      ).toThrow("DISCOVERY_QUERY_RECEIPT_STORE_DIAGNOSTICS_INVALID");
    }
  });

  it("enforces_exact_namespace_byte_budget", () => {
    const newReceipt = makeReceipt({
      queryKey: key(700),
      queryOrdinal: 700,
      sourceClass: "public_intelligence",
      providers: ["registry_frame"],
    });
    const newSettled: Settled = [
      fulfilled("registry_frame", { errorClass: "EMPTY_RESULT", reasonCode: "NO_ROWS" }),
    ];
    const newEntry = {
      queryKey: key(700),
      queryOrdinal: 700,
      sourceClass: "public_intelligence",
      providers: [
        { providerKey: "registry_frame", errorClass: "EMPTY_RESULT", reasonCode: "NO_ROWS" },
      ],
    };
    const addedBytes = 1 + Buffer.byteLength(JSON.stringify(newEntry), "utf8");

    // Deterministic tuner: entries of 16 short provider keys, with up to 61 bytes of
    // padding per key in the last two entries. Consecutive entry counts overlap
    // (slack 2x16x61 > one entry's size), so every target size is reachable.
    function buildBase(count: number): StoredEntry[] {
      return Array.from({ length: count }, (_, index) => ({
        queryKey: key(index + 16),
        queryOrdinal: index,
        sourceClass: "c",
        providers: Array.from({ length: 16 }, (_, providerIndex) =>
          storedProvider(`p${String(providerIndex).padStart(2, "0")}`),
        ),
      }));
    }
    function tuneTo(targetBytes: number): StoredEntry[] {
      for (let count = 4; count < 120; count += 1) {
        const base = buildBase(count);
        const baseBytes = namespaceBytes(base);
        const slack = 2 * 16 * 61;
        if (targetBytes < baseBytes || targetBytes > baseBytes + slack) continue;
        let remaining = targetBytes - baseBytes;
        for (const entryIndex of [count - 1, count - 2]) {
          if (entryIndex < 0 || remaining === 0) continue;
          for (const provider of base[entryIndex]!.providers) {
            const pad = Math.min(61, remaining);
            provider.providerKey += "y".repeat(pad);
            remaining -= pad;
            if (remaining === 0) break;
          }
        }
        expect(remaining).toBe(0);
        expect(namespaceBytes(base)).toBe(targetBytes);
        return base;
      }
      throw new Error(`unreachable byte target ${targetBytes}`);
    }

    // Exact bound: stored namespace + the new entry lands on 65536 bytes.
    const tuned = tuneTo(65536 - addedBytes);
    const atBound = merge(statsWith(tuned), newReceipt, newSettled);
    const persisted = (atBound.queryDiagnostics as { entries: StoredEntry[] }).entries;
    expect(namespaceBytes(persisted)).toBe(65536);

    // One byte over: the same merge is a limit error.
    const over = tuneTo(65536 - addedBytes + 1);
    expect(() => merge(statsWith(over), newReceipt, newSettled)).toThrow(
      "DISCOVERY_QUERY_RECEIPT_STORE_DIAGNOSTICS_LIMIT",
    );
  });

  it("treats prototype-chain names as unknown, not a crash", () => {
    const receipt = makeReceipt();
    for (const errorClass of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const base: Record<string, unknown> = {};
      expect(
        merge(base, receipt, [
          fulfilled("registry_frame", { errorClass, reasonCode: "NO_ROWS" }),
        ]),
      ).toBe(base);
    }
    for (const reasonCode of ["constructor", "toString", "__proto__"]) {
      const base: Record<string, unknown> = {};
      expect(
        merge(base, receipt, [
          fulfilled("registry_frame", { errorClass: "PARAM_INVALID", reasonCode }),
        ]),
      ).toBe(base);
    }
  });

  it("rejects a stored namespace whose provider uses a prototype-chain name", () => {
    for (const errorClass of ["constructor", "toString", "__proto__"]) {
      const stored = statsWith([
        storedEntry(0, {
          providers: [storedProvider("registry_frame", errorClass, "NO_ROWS")],
        }),
      ]);
      expect(() =>
        merge(stored, makeReceipt({ queryOrdinal: 5, queryKey: key(50) }), [
          fulfilled("registry_frame", { errorClass: "EMPTY_RESULT", reasonCode: "NO_ROWS" }),
        ]),
      ).toThrow("DISCOVERY_QUERY_RECEIPT_STORE_DIAGNOSTICS_INVALID");
    }
  });

  it("rejects a stored namespace that repeats a query key", () => {
    const stored = statsWith([
      storedEntry(0, { queryKey: key(1) }),
      storedEntry(1, { queryKey: key(1) }),
    ]);
    // Appending an unrelated query must not re-persist the corrupted store.
    expect(() =>
      merge(stored, makeReceipt({ queryKey: key(2), queryOrdinal: 2 }), [
        fulfilled("registry_frame", { errorClass: "EMPTY_RESULT", reasonCode: "NO_ROWS" }),
      ]),
    ).toThrow("DISCOVERY_QUERY_RECEIPT_STORE_DIAGNOSTICS_INVALID");
    // Looking up a key from the corrupted store fails closed too.
    expect(() =>
      merge(stored, makeReceipt({ queryKey: key(1), queryOrdinal: 0 }), [
        fulfilled("registry_frame", { errorClass: "PARAM_INVALID", reasonCode: "COUNTRY_INVALID" }),
      ]),
    ).toThrow("DISCOVERY_QUERY_RECEIPT_STORE_DIAGNOSTICS_INVALID");
  });

  it("preserves_unrelated_stats_without_mutation", () => {
    const receipt = makeReceipt();
    const perQuery = Object.freeze({ [receipt.queryKey]: Object.freeze({ accepted: 0 }) });
    const input = Object.freeze({
      perQuery,
      perSource: Object.freeze({ company_registry: Object.freeze({ rawCount: 0 }) }),
      rawGovernance: Object.freeze({ accepted: 0 }),
      custom: Object.freeze({ note: "keep" }),
    }) as Record<string, unknown>;
    const result = merge(input, receipt, [
      fulfilled("registry_frame", { errorClass: "EMPTY_RESULT", reasonCode: "NO_ROWS" }),
    ]);
    expect(result).not.toBe(input);
    expect(result.perQuery).toBe(perQuery);
    expect(result.perSource).toEqual({ company_registry: { rawCount: 0 } });
    expect(result.rawGovernance).toEqual({ accepted: 0 });
    expect(result.custom).toEqual({ note: "keep" });
    expect(input).not.toHaveProperty("queryDiagnostics");
  });
});
