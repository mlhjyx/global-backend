import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import {
  PLATFORM_EXECUTION_TECHNICAL_QUOTE_HASH_PREIMAGE_SCHEMA_V1,
  PLATFORM_EXECUTION_TECHNICAL_QUOTE_SCHEMA_V1,
  canonicalizePlatformAuthorityRequestBodyV1,
} from "../../../../packages/contracts/src/platform-authority/canonical-request";
import { loadVerifiedPlatformAuthorityPolicyAsset } from "./platform-authority-policy-asset";
import {
  PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1,
  type PlatformExecutionTechnicalContractV1,
} from "./platform-execution-contract";
import { createPlatformExecutionProviderSnapshotV1 } from "./platform-execution-provider-snapshot";
import {
  PlatformExecutionTechnicalQuoteService,
  type PlatformExecutionTechnicalQuoteV1,
} from "./platform-execution-technical-quote";

type ProviderSnapshotInput = Readonly<{
  schemaVersion: "platform-execution-provider-snapshot/v1";
  scheduleId: string;
  providers: readonly Readonly<{
    providerId: string;
    providerVersion: string;
    enablement: "ENABLED" | "DISABLED";
    bytePriceCatalogRevision: string | null;
  }>[];
}>;

type QuoteVector = Readonly<{
  id: string;
  input: Readonly<{
    purpose: string;
    schedule_id: string;
    workflow_type: string;
    workflow_id: string;
    workflow_run_id: string;
    schedule_request_sha256: string;
    now_epoch_seconds: string;
  }>;
  provider_snapshot: ProviderSnapshotInput;
  expected_quote: PlatformExecutionTechnicalQuoteV1;
}>;

const CORPUS = JSON.parse(
  readFileSync(
    resolve(
      __dirname,
      "../../../../packages/contracts/fixtures/platform-authority/platform-execution-technical-quote-v1.json",
    ),
    "utf8",
  ),
) as Readonly<{
  schema_version: string;
  technical_contract_sha256: string;
  vectors: readonly QuoteVector[];
}>;

function snapshot(input: ProviderSnapshotInput) {
  return createPlatformExecutionProviderSnapshotV1(input);
}

function quote(vector: QuoteVector, overrides: Record<string, unknown> = {}) {
  return new PlatformExecutionTechnicalQuoteService({
    policyAsset: loadVerifiedPlatformAuthorityPolicyAsset(),
    technicalContract: PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1,
  }).quote({
    purpose: vector.input.purpose,
    scheduleId: vector.input.schedule_id,
    workflowType: vector.input.workflow_type,
    workflowId: vector.input.workflow_id,
    workflowRunId: vector.input.workflow_run_id,
    scheduleRequestSha256: vector.input.schedule_request_sha256,
    now: new Date(Number(vector.input.now_epoch_seconds) * 1_000),
    providerSnapshot: snapshot(vector.provider_snapshot),
    ...overrides,
  } as never);
}

function canonicalQuote(value: PlatformExecutionTechnicalQuoteV1) {
  return canonicalizePlatformAuthorityRequestBodyV1({
    contentType: "application/json",
    rawBody: Buffer.from(JSON.stringify(value), "utf8"),
    schema: PLATFORM_EXECUTION_TECHNICAL_QUOTE_SCHEMA_V1,
  });
}

describe("PlatformExecutionTechnicalQuoteService", () => {
  it.each(CORPUS.vectors)(
    "returns the literal cross-language quote for $id",
    (vector) => {
      const actual = quote(vector);
      expect(actual).toEqual(vector.expected_quote);
      expect(canonicalQuote(actual).values).toEqual(vector.expected_quote);

      const { quote_sha256: declared, ...preimage } = actual;
      const canonicalPreimage = canonicalizePlatformAuthorityRequestBodyV1({
        contentType: "application/json",
        rawBody: Buffer.from(JSON.stringify(preimage), "utf8"),
        schema: PLATFORM_EXECUTION_TECHNICAL_QUOTE_HASH_PREIMAGE_SCHEMA_V1,
      });
      expect(
        createHash("sha256")
          .update(canonicalPreimage.canonicalBodyUtf8, "utf8")
          .digest("hex"),
      ).toBe(declared);
      expect(actual.required_campaign_cap_microusd).toBe(
        actual.required_cap_per_run_microusd,
      );
      expect(actual.required_max_runs).toBe("1");
      expect(Number(actual.expires_at) - Number(actual.issued_at)).toBe(300);
      expect(Object.isFrozen(actual)).toBe(true);
    },
  );

  it("has no customer, account, subscription, credit or balance field", () => {
    for (const vector of CORPUS.vectors) {
      expect(Object.keys(quote(vector)).join(" ")).not.toMatch(
        /customer|account|subscription|credit|balance/i,
      );
    }
  });

  it.each([
    ["acq-sweep", "500", "50", "10000", "5000000", "122880", "0", "one_source_provider_per_due_source"],
    ["patents-cache-refresh", "0", "0", "50", "0", "122880", "0", "disabled_no_egress"],
    ["intent-sweep", "5000", "1000", "0", "5000000", "3000000", "3", "all_declared_wires"],
    ["sanctions-refresh", "8", "2", "0", "33554432", "33554432", "3", "all_declared_wires"],
  ] as const)(
    "counts exact physical wires, costed operations and byte domains for %s",
    (
      scheduleId,
      physical,
      costed,
      outputItems,
      transportBytes,
      durableBytes,
      redirects,
      selection,
    ) => {
      const vector = CORPUS.vectors.find((candidate) => candidate.id === scheduleId)!;
      const actual = quote(vector) as unknown as Record<string, string>;

      expect(actual.maximum_physical_invocations).toBe(physical);
      expect(actual.maximum_costed_invocations).toBe(costed);
      expect(actual.maximum_output_items_per_wire).toBe(outputItems);
      expect(actual.maximum_transport_response_bytes_per_wire).toBe(
        transportBytes,
      );
      expect(actual.maximum_durable_result_bytes).toBe(durableBytes);
      expect(actual.maximum_redirects_per_operation).toBe(redirects);
      expect(actual.physical_wire_selection).toBe(selection);
      expect(actual.physical_wire_contracts_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(actual).not.toHaveProperty("maximum_output_bytes_per_wire");
    },
  );

  it.each([
    ["purpose", { purpose: "platform.sanctions" }],
    ["workflow type", { workflowType: "otherWorkflow" }],
    ["workflow id", { workflowId: "contains newline\n" }],
    ["workflow run", { workflowRunId: "NOT-A-LOWERCASE-UUID" }],
    ["request digest", { scheduleRequestSha256: "0".repeat(64) }],
    ["clock", { now: new Date(Number.NaN) }],
  ])("rejects an invalid exact %s binding", (_label, override) => {
    expect(() => quote(CORPUS.vectors[0]!, override)).toThrow(
      "PLATFORM_EXECUTION_BUDGET_QUOTE_INVALID",
    );
  });

  it("fails with POLICY_DRIFT when the imported GrowthOS row no longer matches the shared contract", () => {
    const policyAsset = structuredClone(
      loadVerifiedPlatformAuthorityPolicyAsset(),
    ) as unknown as {
      policy: { rows: Array<{ schedule_request_sha256: string }> };
    };
    policyAsset.policy.rows[0]!.schedule_request_sha256 = "0".repeat(64);
    const service = new PlatformExecutionTechnicalQuoteService({
      policyAsset: policyAsset as never,
      technicalContract: PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1,
    });

    expect(() => service.quote({
      purpose: CORPUS.vectors[0]!.input.purpose,
      scheduleId: CORPUS.vectors[0]!.input.schedule_id,
      workflowType: CORPUS.vectors[0]!.input.workflow_type,
      workflowId: CORPUS.vectors[0]!.input.workflow_id,
      workflowRunId: CORPUS.vectors[0]!.input.workflow_run_id,
      scheduleRequestSha256:
        CORPUS.vectors[0]!.input.schedule_request_sha256,
      now: new Date(
        Number(CORPUS.vectors[0]!.input.now_epoch_seconds) * 1_000,
      ),
      providerSnapshot: snapshot(CORPUS.vectors[0]!.provider_snapshot),
    } as never)).toThrow("PLATFORM_EXECUTION_BUDGET_POLICY_DRIFT");
  });

  it.each([
    ["missing snapshot", undefined],
    ["unbranded clone", structuredClone(CORPUS.vectors[0]!.provider_snapshot)],
    [
      "unknown version",
      snapshot({
        ...CORPUS.vectors[0]!.provider_snapshot,
        providers: [
          {
            ...CORPUS.vectors[0]!.provider_snapshot.providers[0]!,
            providerVersion: "2.0.0",
          },
          CORPUS.vectors[0]!.provider_snapshot.providers[1]!,
        ],
      }),
    ],
  ])("fails with QUOTE_UNAVAILABLE for a %s", (_label, providerSnapshot) => {
    expect(() =>
      quote(CORPUS.vectors[0]!, { providerSnapshot }),
    ).toThrow("PLATFORM_EXECUTION_BUDGET_QUOTE_UNAVAILABLE");
  });

  it.each([null, "f".repeat(64)])(
    "does not quote an enabled patents provider without a trusted bytes price: %s",
    (bytePriceCatalogRevision) => {
      const patents = CORPUS.vectors[1]!;
      const providerSnapshot = snapshot({
        ...patents.provider_snapshot,
        providers: [{
          ...patents.provider_snapshot.providers[0]!,
          enablement: "ENABLED",
          bytePriceCatalogRevision,
        }],
      });

      expect(() => quote(patents, { providerSnapshot })).toThrow(
        "PLATFORM_EXECUTION_BUDGET_QUOTE_UNAVAILABLE",
      );
    },
  );

  it.each([
    ["row", (row: Record<string, unknown>) => delete row.rowId],
    ["provider", (row: Record<string, unknown>) => delete row.providerRequirements],
    ["tool", (row: Record<string, unknown>) => delete row.toolContracts],
    ["tool version", (row: Record<string, unknown>) => {
      (row.toolContracts as Array<Record<string, unknown>>)[0]!.version = "2.0.0";
    }],
    ["price", (row: Record<string, unknown>) => {
      (row.toolContracts as Array<Record<string, unknown>>)[0]!.estimatedCents = "2";
    }],
    ["activity retry", (row: Record<string, unknown>) => delete row.maximumActivityAttempts],
    ["physical wire contracts", (row: Record<string, unknown>) => delete row.physicalWireContracts],
    ["source mix selection", (row: Record<string, unknown>) => delete row.physicalWireSelection],
    ["unbounded fan-out", (row: Record<string, unknown>) => {
      (row.hardBounds as Record<string, unknown>).maximumPhysicalInvocations =
        "9223372036854775807";
    }],
    ["overflowing price envelope", (row: Record<string, unknown>) => {
      (row.toolContracts as Array<Record<string, unknown>>)[0]!.estimatedCents =
        "9223372036854775807";
    }],
    ...[
      "maximumPhysicalInvocations",
      "maximumDueSources",
      "maximumSourceFetchItems",
      "maximumPagesPerSource",
      "maximumSanctionsSources",
      "maximumPatentAnchors",
      "maximumBytesPerPatentAnchor",
      "maximumOutputItemsPerWire",
      "maximumCostedInvocations",
      "maximumTransportResponseBytesPerWire",
      "maximumDurableResultBytes",
      "maximumRedirectsPerOperation",
      "maximumRepairWires",
      "maximumFallbackWires",
      "maximumInputTokens",
      "maximumOutputTokens",
    ].map((field) => [
      field,
      (row: Record<string, unknown>) => {
        delete (row.hardBounds as Record<string, unknown>)[field];
      },
    ] as const),
  ])("detects an omitted or changed %s contract", (_label, mutate) => {
    const contract = structuredClone(
      PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1,
    ) as unknown as { rows: Array<Record<string, unknown>> };
    mutate(contract.rows[0]!);
    const service = new PlatformExecutionTechnicalQuoteService({
      policyAsset: loadVerifiedPlatformAuthorityPolicyAsset(),
      technicalContract: contract as unknown as PlatformExecutionTechnicalContractV1,
    });

    expect(() => service.quote({
      purpose: CORPUS.vectors[0]!.input.purpose,
      scheduleId: CORPUS.vectors[0]!.input.schedule_id,
      workflowType: CORPUS.vectors[0]!.input.workflow_type,
      workflowId: CORPUS.vectors[0]!.input.workflow_id,
      workflowRunId: CORPUS.vectors[0]!.input.workflow_run_id,
      scheduleRequestSha256:
        CORPUS.vectors[0]!.input.schedule_request_sha256,
      now: new Date(
        Number(CORPUS.vectors[0]!.input.now_epoch_seconds) * 1_000,
      ),
      providerSnapshot: snapshot(CORPUS.vectors[0]!.provider_snapshot),
    } as never)).toThrow("PLATFORM_EXECUTION_BUDGET_POLICY_DRIFT");
  });

  it.each([
    ["Algolia pages", 0, 0, "maximumWiresPerOperation", "11"],
    ["Algolia items per page", 0, 0, "maximumItemsPerWire", "1001"],
    ["Algolia raw response bytes", 0, 0, "maximumTransportResponseBytes", "5000001"],
    ["MapYourShow one-wire bound", 0, 1, "maximumWiresPerOperation", "2"],
    ["MapYourShow output items", 0, 1, "maximumItemsPerWire", "9999"],
    ["robots redirect hops", 2, 0, "maximumRedirectsPerOperation", "4"],
    ["robots physical wires", 2, 0, "maximumPhysicalInvocations", "4001"],
    ["Crawl4AI dispatch wires", 2, 1, "maximumPhysicalInvocations", "1001"],
    ["Crawl4AI raw response bytes", 2, 1, "maximumTransportResponseBytes", "5000001"],
    ["sanctions redirect hops", 3, 0, "maximumRedirectsPerOperation", "4"],
    ["sanctions physical wires", 3, 0, "maximumPhysicalInvocations", "9"],
  ] as const)(
    "detects source-specific physical-wire drift: %s",
    (_label, rowIndex, wireIndex, field, value) => {
      const contract = structuredClone(
        PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1,
      ) as unknown as {
        rows: Array<{
          physicalWireContracts: Array<Record<string, unknown>>;
        }>;
      };
      contract.rows[rowIndex]!.physicalWireContracts[wireIndex]![field] = value;
      const service = new PlatformExecutionTechnicalQuoteService({
        policyAsset: loadVerifiedPlatformAuthorityPolicyAsset(),
        technicalContract:
          contract as unknown as PlatformExecutionTechnicalContractV1,
      });
      const vector = CORPUS.vectors[rowIndex]!;

      expect(() => service.quote({
        purpose: vector.input.purpose,
        scheduleId: vector.input.schedule_id,
        workflowType: vector.input.workflow_type,
        workflowId: vector.input.workflow_id,
        workflowRunId: vector.input.workflow_run_id,
        scheduleRequestSha256: vector.input.schedule_request_sha256,
        now: new Date(Number(vector.input.now_epoch_seconds) * 1_000),
        providerSnapshot: snapshot(vector.provider_snapshot),
      } as never)).toThrow("PLATFORM_EXECUTION_BUDGET_POLICY_DRIFT");
    },
  );

  it("binds the independently frozen technical contract digest", () => {
    expect(CORPUS.technical_contract_sha256).toBe(
      "230c0252403f401f35003d3cd3e7d99912ae5689fb84c37bbd50ed624cd9325b",
    );
    expect(CORPUS.vectors).toHaveLength(4);
  });

  it("rejects accessor-backed provider facts before invoking a switching getter", () => {
    let reads = 0;
    const provider = Object.defineProperties({}, {
      providerId: { enumerable: true, value: "tradefair.algolia" },
      providerVersion: {
        enumerable: true,
        get: () => {
          reads += 1;
          return reads === 1 ? "1.0.0" : "forged";
        },
      },
      enablement: { enumerable: true, value: "ENABLED" },
      bytePriceCatalogRevision: { enumerable: true, value: null },
    });

    expect(() => createPlatformExecutionProviderSnapshotV1({
      schemaVersion: "platform-execution-provider-snapshot/v1",
      scheduleId: "acq-sweep",
      providers: [provider],
    })).toThrow("PLATFORM_EXECUTION_CONTRACT_INVALID");
    expect(reads).toBe(0);
  });

  it("never invokes an input-owned providers.map implementation", () => {
    let mapCalls = 0;
    const providers = [CORPUS.vectors[0]!.provider_snapshot.providers[0]!];
    Object.defineProperty(providers, "map", {
      configurable: true,
      value: () => {
        mapCalls += 1;
        return [];
      },
    });

    expect(() => createPlatformExecutionProviderSnapshotV1({
      ...CORPUS.vectors[0]!.provider_snapshot,
      providers,
    })).toThrow("PLATFORM_EXECUTION_CONTRACT_INVALID");
    expect(mapCalls).toBe(0);
  });

  it.each([
    ["sparse", (() => { const value = new Array(1); return value; })()],
    ["extra string key", Object.assign([
      CORPUS.vectors[0]!.provider_snapshot.providers[0]!,
    ], { extra: "forbidden" })],
    ["extra symbol key", (() => {
      const value = [CORPUS.vectors[0]!.provider_snapshot.providers[0]!];
      Object.defineProperty(value, Symbol.iterator, { value: () => [] });
      return value;
    })()],
    ["cross-realm", runInNewContext(`[{providerId:"tradefair.algolia",providerVersion:"1.0.0",enablement:"ENABLED",bytePriceCatalogRevision:null}]`)],
  ])("rejects a %s provider array", (_label, providers) => {
    expect(() => createPlatformExecutionProviderSnapshotV1({
      schemaVersion: "platform-execution-provider-snapshot/v1",
      scheduleId: "acq-sweep",
      providers,
    })).toThrow("PLATFORM_EXECUTION_CONTRACT_INVALID");
  });

  it("rejects a provider-array Proxy without invoking its get trap", () => {
    let getCalls = 0;
    const providers = new Proxy(
      [CORPUS.vectors[0]!.provider_snapshot.providers[0]!],
      {
        get(target, property, receiver) {
          getCalls += 1;
          return Reflect.get(target, property, receiver);
        },
      },
    );

    expect(() => createPlatformExecutionProviderSnapshotV1({
      ...CORPUS.vectors[0]!.provider_snapshot,
      providers,
    })).toThrow("PLATFORM_EXECUTION_CONTRACT_INVALID");
    expect(getCalls).toBe(0);
  });

  it("rejects an accessor-backed provider array index without reading it", () => {
    let reads = 0;
    const providers: unknown[] = [];
    Object.defineProperty(providers, "0", {
      configurable: true,
      enumerable: true,
      get: () => {
        reads += 1;
        return CORPUS.vectors[0]!.provider_snapshot.providers[0]!;
      },
    });
    Object.defineProperty(providers, "length", { value: 1 });

    expect(() => createPlatformExecutionProviderSnapshotV1({
      ...CORPUS.vectors[0]!.provider_snapshot,
      providers,
    })).toThrow("PLATFORM_EXECUTION_CONTRACT_INVALID");
    expect(reads).toBe(0);
  });

  it("rejects a Date subclass before an overridden clock can switch values", () => {
    class SwitchingDate extends Date {
      override getTime(): number {
        return Number(CORPUS.vectors[0]!.input.now_epoch_seconds) * 1_000;
      }
    }

    expect(() =>
      quote(CORPUS.vectors[0]!, {
        now: new SwitchingDate("invalid"),
      }),
    ).toThrow("PLATFORM_EXECUTION_BUDGET_QUOTE_INVALID");
  });
});
