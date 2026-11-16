import { describe, expect, it } from "vitest";
import {
  parseDiscoveryQueryReceipt,
  summarizeDiscoveryQueryReceipts,
  type DiscoveryQueryReceipt,
} from "../discovery/discovery-query-receipt";
import {
  finalizeDiscoveryRunStats,
  projectDiscoveryCompletedStats,
} from "./discovery-run-final-stats";

function key(n: number): string {
  return n.toString(16).padStart(64, "0");
}

function receipt(queryOrdinal: number, overrides: Record<string, unknown> = {}): DiscoveryQueryReceipt {
  return parseDiscoveryQueryReceipt({
    schemaVersion: "discovery-query-receipt/v1",
    queryKey: key(queryOrdinal + 1),
    queryOrdinal,
    sourceClass: "company_registry",
    providers: ["registry_frame"],
    accepted: 1,
    quarantined: 0,
    rejected: 0,
    governanceDenied: 0,
    duplicate: 0,
    usageQuantity: 1,
    costCents: 1,
    ...overrides,
  });
}

function storedWith(...receipts: DiscoveryQueryReceipt[]): Record<string, unknown> {
  return {
    keepStored: "stored",
    perQuery: Object.fromEntries(receipts.map((item) => [item.queryKey, item])),
  };
}

const DIAGNOSTICS = Object.freeze({
  version: 1,
  entries: Object.freeze([
    Object.freeze({
      queryKey: key(1),
      queryOrdinal: 0,
      sourceClass: "company_registry",
      providers: Object.freeze([
        Object.freeze({ providerKey: "registry_frame", errorClass: "PARAM_INVALID", reasonCode: "COUNTRY_INVALID" }),
      ]),
    }),
  ]),
});

describe("finalizeDiscoveryRunStats", () => {
  it("fills a FAILED run from the locked receipts and keeps workflow stats", () => {
    const stored = storedWith(receipt(0));
    const derived = summarizeDiscoveryQueryReceipts(stored);
    const workflow = { perQuery: {}, other: "workflow" };
    const finalStats = finalizeDiscoveryRunStats(stored, workflow, "FAILED");
    expect(finalStats).toEqual({ ...stored, ...workflow, ...derived });
    expect(finalStats.perQuery).toEqual(derived.perQuery);
    expect(finalStats.other).toBe("workflow");

    // A FAILED run without locked receipts keeps the workflow shape as-is.
    const workflowOnly = { other: "workflow" };
    expect(finalizeDiscoveryRunStats({}, workflowOnly, "FAILED")).toBe(workflowOnly);
  });

  it("rejects non-FAILED drift and missing receipts", () => {
    const stored = storedWith(receipt(0));
    expect(() =>
      finalizeDiscoveryRunStats(stored, { perQuery: {} }, "DONE"),
    ).toThrow("DISCOVERY_QUERY_RECEIPT_FINALIZE_DRIFT");
    expect(() =>
      finalizeDiscoveryRunStats(stored, { other: "workflow" }, "PARTIAL"),
    ).toThrow("DISCOVERY_QUERY_RECEIPT_FINALIZE_MISSING");

    // A matching workflow perQuery still merges the locked values over it.
    const derived = summarizeDiscoveryQueryReceipts(stored);
    const workflow = {
      perQuery: derived.perQuery,
      perSource: derived.perSource,
      rawGovernance: derived.rawGovernance,
      other: "workflow",
    };
    const finalStats = finalizeDiscoveryRunStats(stored, workflow, "DONE");
    expect(finalStats.perQuery).toEqual(derived.perQuery);
    expect(finalStats.other).toBe("workflow");
  });

  it("keeps the legacy shape without perQuery", () => {
    const workflow = { other: "workflow" };
    expect(finalizeDiscoveryRunStats({}, workflow, "DONE")).toBe(workflow);
    expect(finalizeDiscoveryRunStats(null, workflow, "CANCELLED")).toBe(workflow);
  });

  it("rejects a corrupted stored stats value", () => {
    for (const broken of ["x", 42, [], true]) {
      expect(() => finalizeDiscoveryRunStats(broken, { other: 1 }, "DONE")).toThrow(
        "DISCOVERY_QUERY_RECEIPT_STORE_INVALID",
      );
    }
  });

  it("preserves locked diagnostics as the only authority", () => {
    const stored = { ...storedWith(receipt(0)), queryDiagnostics: DIAGNOSTICS };
    const workflow = { perQuery: {}, other: "workflow", queryDiagnostics: { version: 9 } };
    const failed = finalizeDiscoveryRunStats(stored, workflow, "FAILED");
    expect(failed.queryDiagnostics).toBe(DIAGNOSTICS);

    // Diagnostics survive finalization even when the perQuery side is empty.
    const diagnosticsOnly = { keep: 1, queryDiagnostics: DIAGNOSTICS };
    const legacy = finalizeDiscoveryRunStats(diagnosticsOnly, { other: 2 }, "DONE");
    expect(legacy.queryDiagnostics).toBe(DIAGNOSTICS);
    // Other stored keys follow the original extraction semantics; only the
    // diagnostics namespace is carried outside the receipt merge.
    expect(legacy.keep).toBeUndefined();
    expect(legacy.other).toBe(2);

    // A FAILED run with no locked receipts still keeps the locked diagnostics.
    const failedNoReceipts = finalizeDiscoveryRunStats(
      { queryDiagnostics: DIAGNOSTICS },
      { other: 3 },
      "FAILED",
    );
    expect(failedNoReceipts.queryDiagnostics).toBe(DIAGNOSTICS);
  });

  it("never injects workflow diagnostics", () => {
    const workflow = { perQuery: {}, other: "workflow", queryDiagnostics: { version: 1 } };
    const done = finalizeDiscoveryRunStats({}, { other: "workflow", queryDiagnostics: { version: 1 } }, "DONE");
    expect(done).not.toHaveProperty("queryDiagnostics");

    // The FAILED spread path must also strip a workflow-injected namespace.
    const failed = finalizeDiscoveryRunStats(storedWith(receipt(0)), workflow, "FAILED");
    expect(failed).not.toHaveProperty("queryDiagnostics");
  });

  it("does not fail on an unknown committed diagnostics version", () => {
    const committed = { version: 99, entries: "whatever" };
    const stored = { ...storedWith(receipt(0)), queryDiagnostics: committed };
    const finalStats = finalizeDiscoveryRunStats(stored, { other: "workflow" }, "FAILED");
    expect(finalStats.queryDiagnostics).toBe(committed);
  });
});

describe("projectDiscoveryCompletedStats", () => {
  it("projects the completion event stats without mutating the input", () => {
    const input = {
      perQuery: { [key(1)]: { accepted: 1 } },
      queryDiagnostics: DIAGNOSTICS,
      cost: 3,
    };
    const projected = projectDiscoveryCompletedStats(input);
    expect(projected).toEqual({ perQuery: input.perQuery, cost: 3 });
    expect(input.queryDiagnostics).toBe(DIAGNOSTICS);
    expect(projected).not.toBe(input);
    expect(projected.perQuery).toBe(input.perQuery);
  });

  it("keeps stats without diagnostics unchanged in value", () => {
    const input = { perQuery: {}, cost: 0 };
    expect(projectDiscoveryCompletedStats(input)).toEqual(input);
  });
});
