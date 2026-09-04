import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  PLATFORM_EXECUTION_TECHNICAL_QUOTE_HASH_PREIMAGE_SCHEMA_V1,
  PLATFORM_EXECUTION_TECHNICAL_QUOTE_SCHEMA_V1,
  canonicalizePlatformAuthorityRequestBodyV1,
} from "../../../../packages/contracts/src/platform-authority/canonical-request";
import { loadVerifiedPlatformAuthorityPolicyAsset } from "./platform-authority-policy-asset";
import {
  PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1,
  createPlatformExecutionProviderSnapshotV1,
  type PlatformExecutionTechnicalContractV1,
} from "./platform-execution-contract";
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
      policy: { rows: Array<{ backend_source_anchor: { request_sha256: string } }> };
    };
    policyAsset.policy.rows[0]!.backend_source_anchor.request_sha256 =
      "0".repeat(64);
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
    ...[
      "maximumPhysicalInvocations",
      "maximumDueSources",
      "maximumSourceFetchItems",
      "maximumPagesPerSource",
      "maximumSanctionsSources",
      "maximumPatentAnchors",
      "maximumBytesPerPatentAnchor",
      "maximumOutputItemsPerWire",
      "maximumOutputBytesPerWire",
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

  it("binds the independently frozen technical contract digest", () => {
    expect(CORPUS.technical_contract_sha256).toBe(
      "dfe00c8a31eff1f10399f789841ddb268bce9162842814bfa105e57a668162b4",
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
