import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { NEW_API_REQUEST_BOUND_RESOLVER_ID } from "../model-gateway/new-api-request-bound-settlement";
import {
  costReconciliationCatalogCoversRoutes,
  createSiteBuildCostReconciliationCatalogFromEnv,
  createSiteBuildCostReconciliationResolverFromEnv,
  createSiteBuildSettlementReadbackRuntimeFromEnv,
  NewApiSiteBuildCostReconciliationResolver,
} from "./site-build-cost-reconciliation-resolver";

const CATALOG_JSON = JSON.stringify({
  schemaVersion: "site-build-cost-reconciliation-catalog/v1",
  catalogId: "site-builder-product-pricing-2026-09-04",
  resolverId: NEW_API_REQUEST_BOUND_RESOLVER_ID,
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
      gatewayCredentialQuotaCapPoints: 2_000_000,
      inputPriceMicrounitsPerMillionTokens: 2_000_000,
      outputPriceMicrounitsPerMillionTokens: 10_000_000,
    },
  ],
});

const DIRECTORY = mkdtempSync(join(tmpdir(), "settlement-resolver-"));
const KEYRING_PATH = join(DIRECTORY, "keyring");
writeFileSync(
  KEYRING_PATH,
  `schema=site-build-settlement-derivation-keyring/v1\n` +
    `settlement-test ACTIVE ${"A".repeat(43)}\n`,
  { mode: 0o600 },
);
afterAll(() => rmSync(DIRECTORY, { recursive: true, force: true }));

const READER_CREDENTIAL = `srb1.${"L".repeat(16)}.${"S".repeat(43)}`;

function authority() {
  return {
    claimModelReadbackProbe: vi.fn(async () => null),
    recordModelReadbackProbe: vi.fn(async () => undefined),
    recordModelPhysicalWireReceipt: vi.fn(async () => undefined),
    completeProviderSpendReconciliation: vi.fn(async (input) => ({
      status: "UNRESOLVED" as const,
      resolverId: input.resolverId,
      observedAt: input.observedAt,
      meta: { reason: "fixture" },
    })),
  };
}

describe("createSiteBuildCostReconciliationCatalogFromEnv", () => {
  it("binds exact provider, task, alias, protocol, output, and price context", () => {
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
      protocol: "openai-responses",
      expectedChannelId: 72,
      pricingCurrency: "USD",
      catalogSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(
      catalog?.resolveContext({
        providerId: "gateway",
        taskId: "site_builder.brand_profile",
        alias: "gpt-5.6-terra",
        maxOutputTokens: 4_001,
      }),
    ).toBeNull();
  });

  it("rejects a partial catalog that cannot price every active route alias", () => {
    const catalog = createSiteBuildCostReconciliationCatalogFromEnv({
      SITE_BUILD_COST_RECONCILIATION_CATALOG_JSON: CATALOG_JSON,
    });

    expect(
      costReconciliationCatalogCoversRoutes(catalog, [
        {
          taskId: "site_builder.brand_profile",
          alias: "gpt-5.6-terra",
          maxOutputTokens: 4_000,
        },
      ]),
    ).toBe(true);
    expect(
      costReconciliationCatalogCoversRoutes(catalog, [
        {
          taskId: "site_builder.brand_profile",
          alias: "gpt-5.6-terra",
          maxOutputTokens: 4_000,
        },
        {
          taskId: "site_builder.copy",
          alias: "claude-sonnet-5",
          maxOutputTokens: 4_000,
        },
      ]),
    ).toBe(false);
  });

  it.each([
    [undefined, "missing"],
    ["not-json", "malformed"],
    [` ${CATALOG_JSON}`, "non-canonical whitespace"],
    [
      JSON.stringify({ ...JSON.parse(CATALOG_JSON), pricingCurrency: "CNY" }),
      "implicit FX",
    ],
    [
      JSON.stringify({
        ...JSON.parse(CATALOG_JSON),
        resolverId: "foreign-resolver",
      }),
      "resolver drift",
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
        entries: [
          {
            ...JSON.parse(CATALOG_JSON).entries[0],
            alias: `a${"x".repeat(120)}`,
            protocol: "openai-chat-completions",
          },
        ],
      }),
      "model alias wider than durable projection",
    ],
    [
      JSON.stringify({
        ...JSON.parse(CATALOG_JSON),
        entries: [
          {
            ...JSON.parse(CATALOG_JSON).entries[0],
            expectedChannelId: 1_000_000_001,
          },
        ],
      }),
      "channel wider than durable projection",
    ],
    [
      JSON.stringify({
        ...JSON.parse(CATALOG_JSON),
        entries: [
          {
            ...JSON.parse(CATALOG_JSON).entries[0],
            gatewayCredentialQuotaCapPoints: 1_000_000_001,
          },
        ],
      }),
      "quota wider than durable projection",
    ],
    [
      JSON.stringify({
        ...JSON.parse(CATALOG_JSON),
        entries: [
          {
            ...JSON.parse(CATALOG_JSON).entries[0],
            maxOutputTokensPerCall: 1_000_000_001,
          },
        ],
      }),
      "output-token cap wider than durable projection",
    ],
    [
      JSON.stringify({
        ...JSON.parse(CATALOG_JSON),
        entries: [
          {
            ...JSON.parse(CATALOG_JSON).entries[0],
            inputPriceMicrounitsPerMillionTokens: 500_000_000_001,
          },
        ],
      }),
      "price capable of exceeding durable cost projection",
    ],
  ])("fails closed for %s (%s)", (raw) => {
    expect(
      createSiteBuildCostReconciliationCatalogFromEnv(
        raw === undefined
          ? {}
          : { SITE_BUILD_COST_RECONCILIATION_CATALOG_JSON: raw },
      ),
    ).toBeUndefined();
  });
});

describe("settlement readback runtime factory", () => {
  it("builds one shared resolver/keyring compatibility tuple", () => {
    const wireAuthority = authority();
    const runtime = createSiteBuildSettlementReadbackRuntimeFromEnv(
      wireAuthority,
      {
        MODEL_GATEWAY_URL: "http://127.0.0.1:3010/v1",
        MODEL_GATEWAY_SETTLEMENT_READBACK_CREDENTIAL: READER_CREDENTIAL,
        SITE_BUILD_SETTLEMENT_DERIVATION_KEYRING_FILE: KEYRING_PATH,
        SITE_BUILD_COST_RECONCILIATION_POLL_MS: "5000",
      },
    );

    expect(runtime?.resolver).toBeDefined();
    expect(runtime?.keyring.activeKeyId).toBe("settlement-test");
    expect(runtime?.reconciliationResolver).toBeInstanceOf(
      NewApiSiteBuildCostReconciliationResolver,
    );
    expect(
      createSiteBuildCostReconciliationResolverFromEnv(wireAuthority, {
        MODEL_GATEWAY_URL: "http://127.0.0.1:3010/v1",
        MODEL_GATEWAY_SETTLEMENT_READBACK_CREDENTIAL: READER_CREDENTIAL,
        SITE_BUILD_SETTLEMENT_DERIVATION_KEYRING_FILE: KEYRING_PATH,
      }),
    ).toBeInstanceOf(NewApiSiteBuildCostReconciliationResolver);
  });

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
      "missing reader",
    ],
    [
      {
        MODEL_GATEWAY_URL: "https://gateway.example.test",
        MODEL_GATEWAY_SETTLEMENT_READBACK_CREDENTIAL: READER_CREDENTIAL,
      },
      "missing keyring",
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
        MODEL_GATEWAY_SETTLEMENT_READBACK_CREDENTIAL: "dispatch-token",
        SITE_BUILD_SETTLEMENT_DERIVATION_KEYRING_FILE: KEYRING_PATH,
      },
      "wrong credential family",
    ],
  ])("fails closed for %s (%s)", (env) => {
    expect(
      createSiteBuildSettlementReadbackRuntimeFromEnv(
        authority(),
        env as NodeJS.ProcessEnv,
      ),
    ).toBeUndefined();
  });

  it("rejects a readback credential reused as the dispatch credential", () => {
    expect(
      createSiteBuildSettlementReadbackRuntimeFromEnv(authority(), {
        MODEL_GATEWAY_URL: "https://gateway.example.test",
        MODEL_GATEWAY_KEY: READER_CREDENTIAL,
        MODEL_GATEWAY_SETTLEMENT_READBACK_CREDENTIAL: READER_CREDENTIAL,
        SITE_BUILD_SETTLEMENT_DERIVATION_KEYRING_FILE: KEYRING_PATH,
      }),
    ).toBeUndefined();
  });

  it("rejects whitespace-padded credential reuse", () => {
    expect(
      createSiteBuildSettlementReadbackRuntimeFromEnv(authority(), {
        MODEL_GATEWAY_URL: "https://gateway.example.test",
        MODEL_GATEWAY_KEY: ` ${READER_CREDENTIAL} `,
        MODEL_GATEWAY_SETTLEMENT_READBACK_CREDENTIAL: READER_CREDENTIAL,
        SITE_BUILD_SETTLEMENT_DERIVATION_KEYRING_FILE: KEYRING_PATH,
      }),
    ).toBeUndefined();
  });
});
