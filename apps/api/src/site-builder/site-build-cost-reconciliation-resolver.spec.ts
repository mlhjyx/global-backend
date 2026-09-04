import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  parseSettlementDerivationKeyring,
  settlementWireIdentities,
  toDurableSettlementWireIdentity,
} from "../model-gateway/settlement-wire-identity";
import {
  createSiteBuildCostReconciliationCatalogFromEnv,
  createSiteBuildCostReconciliationResolverFromEnv,
  NewApiSiteBuildCostReconciliationResolver,
} from "./site-build-cost-reconciliation-resolver";

const CATALOG_JSON = JSON.stringify({
  schemaVersion: "site-build-cost-reconciliation-catalog/v1",
  catalogId: "site-builder-product-pricing-2026-08-16",
  resolverId: "new-api-request-bound-reconciliation-v1",
  pricingAuthority: "openox_model_marketplace",
  pricingSnapshotSha256: "f".repeat(64),
  pricingCurrency: "USD",
  ledgerMicrousdPerPricingUnit: 1_000_000,
  entries: [
    {
      providerId: "gateway",
      taskId: "site_builder.brand_profile",
      alias: "gpt-5.6-terra",
      protocol: "openai-responses",
      expectedChannelId: 72,
      maxOutputTokensPerCall: 4_000,
      gatewayCredentialQuotaCapPoints: 2_000,
      inputPriceMicrounitsPerMillionTokens: 2_000_000,
      outputPriceMicrounitsPerMillionTokens: 10_000_000,
    },
  ],
});

const READER_CREDENTIAL = `srb1.${"L".repeat(16)}.${"S".repeat(43)}`;
const DERIVATION_SECRET = "A".repeat(43);
const KEYRING_RAW =
  `schema=site-build-settlement-derivation-keyring/v1\n` +
  `settlement-test ACTIVE ${DERIVATION_SECRET}\n`;
const DERIVATION_KEYRING = parseSettlementDerivationKeyring(
  Buffer.from(KEYRING_RAW),
);
const OPERATION_KEY = "b".repeat(64);
const WIRE_IDENTITY = settlementWireIdentities(
  DERIVATION_KEYRING,
  OPERATION_KEY,
  1,
)[0]!;
const REQUEST_ID = WIRE_IDENTITY.requestId;
const KEYRING_DIRECTORY = mkdtempSync(join(tmpdir(), "settlement-resolver-"));
const KEYRING_PATH = join(KEYRING_DIRECTORY, "keyring");
writeFileSync(KEYRING_PATH, KEYRING_RAW, { mode: 0o600 });
afterAll(() => rmSync(KEYRING_DIRECTORY, { recursive: true, force: true }));

const TRUSTED_META = {
  gatewaySettlements: [
    {
      status: "unknown",
      requestId: REQUEST_ID,
      resolverId: "new-api-request-bound-reconciliation-v1",
      physicalWireAttempt: 1,
    },
  ],
  settlementWireIdentities: [toDurableSettlementWireIdentity(WIRE_IDENTITY)],
  settlementContext: {
    schemaVersion: "site-build-cost-reconciliation-catalog/v1",
    catalogId: "site-builder-product-pricing-2026-08-16",
    catalogSha256: "e".repeat(64),
    pricingAuthority: "openox_model_marketplace",
    pricingSnapshotSha256: "f".repeat(64),
    pricingCurrency: "USD",
    providerId: "gateway",
    taskId: "site_builder.brand_profile",
    resolverId: "new-api-request-bound-reconciliation-v1",
    alias: "gpt-5.6-terra",
    protocol: "openai-responses",
    expectedChannelId: 72,
    maxOutputTokensPerCall: 4_000,
    gatewayCredentialQuotaCapPoints: 2_000,
    inputPriceMicrounitsPerMillionTokens: 2_000_000,
    outputPriceMicrounitsPerMillionTokens: 10_000_000,
    ledgerMicrousdPerPricingUnit: 1_000_000,
  },
};

describe("NewApiSiteBuildCostReconciliationResolver", () => {
  it("turns a trusted request-bound receipt and frozen price mapping into RESOLVED", async () => {
    const resolve = vi.fn(async () => ({
      status: "settled" as const,
      requestId: REQUEST_ID,
      resolverId: "new-api-request-bound-reconciliation-v1",
      alias: "gpt-5.6-terra",
      protocol: "openai-responses",
      channelId: 72,
      quota: 1_250,
      inputTokens: 120,
      outputTokens: 30,
      upstreamIdState: "observed" as const,
      receiptDigest: "a".repeat(64),
      physicalCallCount: 0 as const,
      readbackProbes: [],
    }));
    const resolver = new NewApiSiteBuildCostReconciliationResolver(
      { resolve },
      DERIVATION_KEYRING,
    );

    await expect(
      resolver.resolve({
        spendId: "spend-1",
        operationKey: OPERATION_KEY,
        meta: TRUSTED_META,
      }),
    ).resolves.toMatchObject({
      status: "RESOLVED",
      receiptDigest: "a".repeat(64),
      costBasis: "token_pricing",
      exactCostMicrousd: "540",
      inputTokens: 120,
      outputTokens: 30,
    });
    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: REQUEST_ID,
        nonce: WIRE_IDENTITY.nonce,
        alias: "gpt-5.6-terra",
        expectedChannelId: 72,
        maximumQuotaPoints: 2_000,
      }),
    );
  });

  it("does not query provider accounting without the complete trusted pricing context", async () => {
    const resolve = vi.fn();
    const resolver = new NewApiSiteBuildCostReconciliationResolver(
      { resolve },
      DERIVATION_KEYRING,
    );

    await expect(
      resolver.resolve({
        spendId: "spend-1",
        operationKey: OPERATION_KEY,
        meta: null,
      }),
    ).resolves.toMatchObject({
      status: "UNRESOLVED",
      meta: { reason: "trusted_settlement_context_unavailable" },
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    ["primitive preflight", { ...TRUSTED_META, settlementContext: "invalid" }],
    ["array preflight", { ...TRUSTED_META, settlementContext: [] }],
    ["non-array settlements", { ...TRUSTED_META, gatewaySettlements: {} }],
    [
      "non-object settlement entries",
      {
        ...TRUSTED_META,
        gatewaySettlements: [null, "invalid", [], { status: "settled" }],
      },
    ],
    [
      "missing request identity",
      {
        ...TRUSTED_META,
        gatewaySettlements: [
          { ...TRUSTED_META.gatewaySettlements[0], requestId: 7 },
        ],
      },
    ],
    [
      "missing resolver identity",
      {
        ...TRUSTED_META,
        settlementContext: { ...TRUSTED_META.settlementContext, resolverId: 7 },
      },
    ],
    [
      "resolver identity mismatch",
      {
        ...TRUSTED_META,
        gatewaySettlements: [
          {
            ...TRUSTED_META.gatewaySettlements[0],
            resolverId: "different-resolver",
          },
        ],
      },
    ],
    [
      "missing alias",
      {
        ...TRUSTED_META,
        settlementContext: { ...TRUSTED_META.settlementContext, alias: 7 },
      },
    ],
    [
      "missing protocol",
      {
        ...TRUSTED_META,
        settlementContext: { ...TRUSTED_META.settlementContext, protocol: 7 },
      },
    ],
    ...[
      "expectedChannelId",
      "maxOutputTokensPerCall",
      "gatewayCredentialQuotaCapPoints",
      "ledgerMicrousdPerPricingUnit",
    ].map((field) => [
      `invalid ${field}`,
      {
        ...TRUSTED_META,
        settlementContext: { ...TRUSTED_META.settlementContext, [field]: 0 },
      },
    ]),
    ...[
      "inputPriceMicrounitsPerMillionTokens",
      "outputPriceMicrounitsPerMillionTokens",
    ].map((field) => [
      `invalid ${field}`,
      {
        ...TRUSTED_META,
        settlementContext: { ...TRUSTED_META.settlementContext, [field]: -1 },
      },
    ]),
  ])("rejects %s before provider accounting", async (_label, meta) => {
    const resolve = vi.fn();
    const resolver = new NewApiSiteBuildCostReconciliationResolver(
      { resolve },
      DERIVATION_KEYRING,
    );

    await expect(
      resolver.resolve({
        spendId: "spend-1",
        operationKey: OPERATION_KEY,
        meta: meta as Record<string, unknown>,
      }),
    ).resolves.toMatchObject({
      status: "UNRESOLVED",
      meta: { reason: "trusted_settlement_context_unavailable" },
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("keeps provider accounting unknown observations unresolved", async () => {
    const resolver = new NewApiSiteBuildCostReconciliationResolver(
      {
        resolve: vi.fn(async () => ({
          status: "unknown" as const,
          requestId: REQUEST_ID,
          resolverId: "new-api-request-bound-reconciliation-v1",
          reason: "gateway_log_unavailable" as const,
          physicalCallCount: 0 as const,
          readbackProbes: [],
        })),
      },
      DERIVATION_KEYRING,
    );

    await expect(
      resolver.resolve({
        spendId: "spend-1",
        operationKey: OPERATION_KEY,
        meta: TRUSTED_META,
      }),
    ).resolves.toMatchObject({
      status: "UNRESOLVED",
      requestId: REQUEST_ID,
      meta: { reason: "gateway_log_unavailable" },
    });
  });

  it("rejects a receipt produced by a different resolver identity", async () => {
    const resolver = new NewApiSiteBuildCostReconciliationResolver(
      {
        resolve: vi.fn(async () => ({
          status: "settled" as const,
          requestId: REQUEST_ID,
          resolverId: "unexpected-resolver",
          alias: "gpt-5.6-terra",
          protocol: "openai-responses",
          channelId: 72,
          quota: 1,
          inputTokens: 1,
          outputTokens: 1,
          upstreamIdState: "absent" as const,
          receiptDigest: "c".repeat(64),
          physicalCallCount: 0 as const,
          readbackProbes: [],
        })),
      } as never,
      DERIVATION_KEYRING,
    );

    await expect(
      resolver.resolve({
        spendId: "spend-1",
        operationKey: OPERATION_KEY,
        meta: TRUSTED_META,
      }),
    ).resolves.toMatchObject({
      status: "UNRESOLVED",
      meta: { reason: "resolver_identity_mismatch" },
    });
  });

  it("does not project a monetary fact when trusted price arithmetic is outside the safe range", async () => {
    const resolver = new NewApiSiteBuildCostReconciliationResolver(
      {
        resolve: vi.fn(async () => ({
          status: "settled" as const,
          requestId: REQUEST_ID,
          resolverId: "new-api-request-bound-reconciliation-v1",
          alias: "gpt-5.6-terra",
          protocol: "openai-responses",
          channelId: 72,
          quota: 1,
          inputTokens: Number.MAX_SAFE_INTEGER,
          outputTokens: Number.MAX_SAFE_INTEGER,
          upstreamIdState: "observed" as const,
          receiptDigest: "d".repeat(64),
          physicalCallCount: 0 as const,
          readbackProbes: [],
        })),
      },
      DERIVATION_KEYRING,
    );

    await expect(
      resolver.resolve({
        spendId: "spend-1",
        operationKey: OPERATION_KEY,
        meta: {
          ...TRUSTED_META,
          settlementContext: {
            ...TRUSTED_META.settlementContext,
            inputPriceMicrounitsPerMillionTokens: Number.MAX_SAFE_INTEGER,
            outputPriceMicrounitsPerMillionTokens: Number.MAX_SAFE_INTEGER,
          },
        },
      }),
    ).resolves.toMatchObject({
      status: "UNRESOLVED",
      meta: { reason: "trusted_price_mapping_invalid" },
    });
  });
});

describe("createSiteBuildCostReconciliationResolverFromEnv", () => {
  it.each([
    [
      {
        MODEL_GATEWAY_SETTLEMENT_READBACK_CREDENTIAL: READER_CREDENTIAL,
        SITE_BUILD_SETTLEMENT_DERIVATION_KEYRING_FILE: KEYRING_PATH,
      },
      "missing URL",
    ],
    [
      {
        MODEL_GATEWAY_URL: "https://gateway.example.test",
        SITE_BUILD_SETTLEMENT_DERIVATION_KEYRING_FILE: KEYRING_PATH,
      },
      "missing reader credential",
    ],
    [
      {
        MODEL_GATEWAY_URL: "not-a-url",
        MODEL_GATEWAY_SETTLEMENT_READBACK_CREDENTIAL: READER_CREDENTIAL,
        SITE_BUILD_SETTLEMENT_DERIVATION_KEYRING_FILE: KEYRING_PATH,
      },
      "invalid URL",
    ],
    [
      {
        MODEL_GATEWAY_URL: "https://gateway.example.test",
        MODEL_GATEWAY_SETTLEMENT_READBACK_CREDENTIAL: READER_CREDENTIAL,
      },
      "missing derivation keyring",
    ],
  ])("fails closed for %s (%s)", (env) => {
    expect(
      createSiteBuildCostReconciliationResolverFromEnv(
        env as NodeJS.ProcessEnv,
      ),
    ).toBeUndefined();
  });

  it.each([
    [undefined, "default"],
    ["0", "lower clamp"],
    ["60000", "upper clamp"],
    ["not-a-number", "invalid fallback"],
  ])(
    "constructs the request-bound adapter with %s poll duration (%s)",
    (poll) => {
      expect(
        createSiteBuildCostReconciliationResolverFromEnv({
          MODEL_GATEWAY_URL: "http://127.0.0.1:3010/v1",
          MODEL_GATEWAY_SETTLEMENT_READBACK_CREDENTIAL: READER_CREDENTIAL,
          SITE_BUILD_SETTLEMENT_DERIVATION_KEYRING_FILE: KEYRING_PATH,
          ...(poll === undefined
            ? {}
            : { SITE_BUILD_COST_RECONCILIATION_POLL_MS: poll }),
        }),
      ).toBeInstanceOf(NewApiSiteBuildCostReconciliationResolver);
    },
  );
});

describe("createSiteBuildCostReconciliationCatalogFromEnv", () => {
  it("binds exact product provider/task/alias identity and output ceiling", () => {
    const catalog = createSiteBuildCostReconciliationCatalogFromEnv({
      SITE_BUILD_COST_RECONCILIATION_CATALOG_JSON: CATALOG_JSON,
    });

    expect(
      catalog?.resolveContext({
        providerId: "gateway",
        taskId: "site_builder.brand_profile",
        alias: "gpt-5.6-terra",
        maxOutputTokens: 1_000,
      }),
    ).toMatchObject({
      schemaVersion: "site-build-cost-reconciliation-catalog/v1",
      catalogId: "site-builder-product-pricing-2026-08-16",
      catalogSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      protocol: "openai-responses",
      expectedChannelId: 72,
      pricingCurrency: "USD",
    });
    expect(
      catalog?.resolveContext({
        providerId: "gateway",
        taskId: "site_builder.brand_profile",
        alias: "gpt-5.6-terra",
        maxOutputTokens: 4_001,
      }),
    ).toBeNull();
    expect(
      catalog?.resolveContext({
        providerId: "gateway",
        taskId: "site_builder.copy",
        alias: "gpt-5.6-terra",
        maxOutputTokens: 1_000,
      }),
    ).toBeNull();
  });

  it.each([
    [undefined, "missing"],
    ["not-json", "malformed"],
    [` ${CATALOG_JSON}`, "non-canonical"],
    [
      JSON.stringify({
        ...JSON.parse(CATALOG_JSON),
        pricingCurrency: "CNY",
      }),
      "implicit FX",
    ],
    [
      JSON.stringify({
        ...JSON.parse(CATALOG_JSON),
        entries: [
          {
            ...JSON.parse(CATALOG_JSON).entries[0],
            protocol: "openai-chat-completions",
          },
        ],
      }),
      "route protocol drift",
    ],
    [
      JSON.stringify({
        ...JSON.parse(CATALOG_JSON),
        resolverId: "foreign-resolver",
      }),
      "resolver identity drift",
    ],
  ])("fails closed for %s catalog (%s)", (raw) => {
    expect(
      createSiteBuildCostReconciliationCatalogFromEnv(
        raw === undefined
          ? {}
          : { SITE_BUILD_COST_RECONCILIATION_CATALOG_JSON: raw },
      ),
    ).toBeUndefined();
  });
});
