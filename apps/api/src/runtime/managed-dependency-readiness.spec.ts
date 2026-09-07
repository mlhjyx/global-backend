import { describe, expect, it, vi } from "vitest";
import {
  checkBrowserReadiness,
  checkExecutionBudgetJwksReadiness,
  checkGenericArtifactStorageReadiness,
  checkImagePipelineIsolationReadiness,
  checkModelGatewayReadiness,
  checkPlatformBudgetAuthorityReadiness,
  checkRedisReadiness,
  checkSiteBuildSettlementReadbackReadiness,
  ExecutionBudgetAuthorityReadinessContributors,
  inspectPlatformBudgetAuthorityReadiness,
  ManagedDependencyReadinessContributors,
  rendererRuntimeIdentity,
} from "./managed-dependency-readiness";
import { RuntimeReadinessContributorRegistry } from "./runtime-readiness-registry";
import {
  platformAutomationReadinessFactName,
  type PlatformAutomationExternalReadinessFact,
} from "../platform-authority/platform-automation-readiness";
import { PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1 } from "../platform-authority/platform-execution-contract";
import { PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_READINESS_CONTRIBUTOR } from "../platform-authority/platform-technical-quote-service-auth";

const identity = {
  attested: true as const,
  schema_version: "global-runtime-release-identity/v1" as const,
  build_sha: "a".repeat(40),
  built_at: "2026-08-16T00:00:00.000Z",
  image_digest: `sha256:${"b".repeat(64)}`,
  artifact_digest: `sha256:${"c".repeat(64)}`,
  artifact_manifest_digest: `sha256:${"d".repeat(64)}`,
  sbom_digest: `sha256:${"e".repeat(64)}`,
  source_tree_digest: `sha256:${"f".repeat(64)}`,
  renderer_digest: `sha256:${"1".repeat(64)}`,
  migration_revision: "20260816000000_runtime_process_lease",
  schema_digest: `sha256:${"2".repeat(64)}`,
};

const EXECUTION_BUDGET_ENV = {
  APP_ENVIRONMENT: "test",
  NODE_ENV: "test",
  EXECUTION_BUDGET_GRANT_JWKS_URI:
    "http://127.0.0.1:3100/.well-known/execution-budget-jwks.json",
  EXECUTION_BUDGET_GRANT_ISSUER: "http://127.0.0.1:3100/",
  EXECUTION_BUDGET_GRANT_AUDIENCE: "global-backend:execution-budget",
  EXECUTION_BUDGET_GRANT_ALGORITHMS: "RS256,ES256,EdDSA",
};

const EXECUTION_ES256_PUBLIC_JWK = {
  kty: "EC",
  x: "RlAKnjNRkDLUtlfnTfa-PEqUIqRKwc9wqeL_jYz-l7s",
  y: "mEe-HjWcVujdmIJJc8Dyu4SQf1JGccAAnv2_uMOj-f4",
  crv: "P-256",
  alg: "ES256",
  kid: "execution-es256-1",
  use: "sig",
};

describe("managed dependency readiness", () => {
  function platformRegistry(input?: {
    readonly includeQuoteAuthentication?: boolean;
    readonly omit?: Readonly<{
      fact: PlatformAutomationExternalReadinessFact;
      scheduleId: string;
    }>;
  }) {
    const registry = new RuntimeReadinessContributorRegistry();
    if (input?.includeQuoteAuthentication !== false) {
      registry.register(
        PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_READINESS_CONTRIBUTOR,
        () => ({ status: "ok" }),
      );
    }
    for (const row of PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1.rows) {
      for (const fact of [
        "temporal_proof",
        "issuer",
        "revocation_delivery",
      ] as const) {
        if (
          input?.omit?.fact === fact &&
          input.omit.scheduleId === row.scheduleId
        ) {
          continue;
        }
        registry.register(
          platformAutomationReadinessFactName(fact, row.scheduleId),
          () => ({ status: "ok" }),
        );
      }
    }
    return registry;
  }

  function platformSource(status: "available" | "writer_unavailable" = "available") {
    return {
      inspectPlatformWriterCapability: vi.fn(async () => ({ status } as const)),
    };
  }

  it("probes the dedicated settlement-readback capability without a model call", async () => {
    const reader = `srb1.${"L".repeat(16)}.${"S".repeat(43)}`;
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            schema_version: "new-api-settlement-readback-capability/v1",
            status: "ready",
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "cache-control": "no-store",
              "x-new-api-settlement-contract": "new-api-settlement-readback/v1",
            },
          },
        ),
    );
    const loadKeyring = vi.fn(() => ({ activeKeyId: "settlement-test" }));

    await expect(
      checkSiteBuildSettlementReadbackReadiness(
        {
          MODEL_GATEWAY_URL: "http://127.0.0.1:3010/v1",
          MODEL_GATEWAY_SETTLEMENT_READBACK_CREDENTIAL: reader,
          SITE_BUILD_SETTLEMENT_DERIVATION_KEYRING_FILE:
            "/run/secrets/site-build-settlement-keyring",
        },
        fetcher,
        loadKeyring as never,
      ),
    ).resolves.toEqual({ status: "ok" });
    expect(loadKeyring).toHaveBeenCalledWith(
      "/run/secrets/site-build-settlement-keyring",
    );
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:3010/api/settlement-readback/v1/capability",
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${reader}`,
        },
      }),
    );
  });

  it("does not probe when dispatch and readback credentials are byte-equal", async () => {
    const reused = `srb1.${"L".repeat(16)}.${"S".repeat(43)}`;
    const fetcher = vi.fn();
    const loadKeyring = vi.fn();

    await expect(
      checkSiteBuildSettlementReadbackReadiness(
        {
          MODEL_GATEWAY_URL: "http://127.0.0.1:3010/v1",
          MODEL_GATEWAY_KEY: reused,
          MODEL_GATEWAY_SETTLEMENT_READBACK_CREDENTIAL: reused,
          SITE_BUILD_SETTLEMENT_DERIVATION_KEYRING_FILE: "/secret/keyring",
        },
        fetcher,
        loadKeyring as never,
      ),
    ).resolves.toEqual({
      status: "failed",
      code: "SITE_BUILD_MODEL_SETTLEMENT_READBACK_CONFIG_REQUIRED",
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(loadKeyring).not.toHaveBeenCalled();
  });

  it("does not probe when dispatch credential padding would normalize to the reader", async () => {
    const reused = `srb1.${"L".repeat(16)}.${"S".repeat(43)}`;
    const fetcher = vi.fn();
    const loadKeyring = vi.fn();

    await expect(
      checkSiteBuildSettlementReadbackReadiness(
        {
          MODEL_GATEWAY_URL: "http://127.0.0.1:3010/v1",
          MODEL_GATEWAY_KEY: ` ${reused} `,
          MODEL_GATEWAY_SETTLEMENT_READBACK_CREDENTIAL: reused,
          SITE_BUILD_SETTLEMENT_DERIVATION_KEYRING_FILE: "/secret/keyring",
        },
        fetcher,
        loadKeyring as never,
      ),
    ).resolves.toEqual({
      status: "failed",
      code: "SITE_BUILD_MODEL_SETTLEMENT_READBACK_CONFIG_REQUIRED",
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(loadKeyring).not.toHaveBeenCalled();
  });

  it("fails settlement readiness before network when either secret family is missing", async () => {
    const fetcher = vi.fn();
    const loadKeyring = vi.fn();

    await expect(
      checkSiteBuildSettlementReadbackReadiness(
        { MODEL_GATEWAY_URL: "http://127.0.0.1:3010/v1" },
        fetcher,
        loadKeyring as never,
      ),
    ).resolves.toEqual({
      status: "failed",
      code: "SITE_BUILD_MODEL_SETTLEMENT_READBACK_CONFIG_REQUIRED",
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(loadKeyring).not.toHaveBeenCalled();
  });

  it("bounds a drifted settlement capability to one stable unavailable code", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response('{"status":"ready","schema_version":"wrong"}', {
          status: 200,
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
            "x-new-api-settlement-contract": "new-api-settlement-readback/v1",
          },
        }),
    );

    await expect(
      checkSiteBuildSettlementReadbackReadiness(
        {
          MODEL_GATEWAY_URL: "http://127.0.0.1:3010/v1",
          MODEL_GATEWAY_SETTLEMENT_READBACK_CREDENTIAL: `srb1.${"L".repeat(16)}.${"S".repeat(43)}`,
          SITE_BUILD_SETTLEMENT_DERIVATION_KEYRING_FILE: "/secret/keyring",
        },
        fetcher,
        vi.fn(() => ({ activeKeyId: "settlement-test" })) as never,
      ),
    ).resolves.toEqual({
      status: "failed",
      code: "SITE_BUILD_MODEL_SETTLEMENT_READBACK_UNAVAILABLE",
    });
  });

  it("rejects an unsafe execution-budget JWKS URL before network dispatch", async () => {
    const unsafe =
      "https://user:must-never-leak@control-plane.example.test/jwks?redirect=evil";
    const fetcher = vi.fn();

    const result = await checkExecutionBudgetJwksReadiness(
      {
        APP_ENVIRONMENT: "production",
        NODE_ENV: "production",
        EXECUTION_BUDGET_GRANT_JWKS_URI: unsafe,
        EXECUTION_BUDGET_GRANT_ISSUER: "https://control-plane.example.test/",
        EXECUTION_BUDGET_GRANT_AUDIENCE: "global-backend:execution-budget",
        EXECUTION_BUDGET_GRANT_ALGORITHMS: "RS256,ES256,EdDSA",
      },
      fetcher,
    );

    expect(result).toEqual({
      status: "failed",
      code: "EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE",
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(unsafe);
    expect(JSON.stringify(result)).not.toContain("must-never-leak");
  });

  it("probes the configured execution-budget JWKS with a bounded redirect-free request", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            keys: [EXECUTION_ES256_PUBLIC_JWK],
          }),
          { status: 200 },
        ),
    );

    const result = await checkExecutionBudgetJwksReadiness(
      EXECUTION_BUDGET_ENV,
      fetcher,
    );

    expect(result).toEqual({ status: "ok" });
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:3100/.well-known/execution-budget-jwks.json",
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
  });

  it.each([
    [
      "an unusable public key",
      {
        ...EXECUTION_ES256_PUBLIC_JWK,
        x: "x",
        y: "y",
      },
    ],
    [
      "private key material",
      {
        ...EXECUTION_ES256_PUBLIC_JWK,
        d: "WRRQcLrRvsQguZtooDJ6t3J-rcSfYKZjJzbnf0VdVtQ",
      },
    ],
    [
      "an algorithm-incompatible key",
      {
        ...EXECUTION_ES256_PUBLIC_JWK,
        alg: "RS256",
      },
    ],
  ])("rejects an execution-budget JWKS containing %s", async (_name, key) => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ keys: [key] }), { status: 200 }),
    );

    await expect(
      checkExecutionBudgetJwksReadiness(EXECUTION_BUDGET_ENV, fetcher),
    ).resolves.toEqual({
      status: "failed",
      code: "EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE",
    });
  });

  it("rejects loopback HTTP execution-budget trust roots in production", async () => {
    const fetcher = vi.fn();

    const result = await checkExecutionBudgetJwksReadiness(
      {
        APP_ENVIRONMENT: "production",
        NODE_ENV: "production",
        EXECUTION_BUDGET_GRANT_JWKS_URI: "http://127.0.0.1:3100/jwks",
        EXECUTION_BUDGET_GRANT_ISSUER: "http://127.0.0.1:3100/",
        EXECUTION_BUDGET_GRANT_AUDIENCE: "global-backend:execution-budget",
        EXECUTION_BUDGET_GRANT_ALGORITHMS: "RS256,ES256,EdDSA",
      },
      fetcher,
    );

    expect(result).toEqual({
      status: "failed",
      code: "EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports a missing deployment-owned platform writer without falling back to another principal", async () => {
    await expect(
      checkPlatformBudgetAuthorityReadiness(undefined, platformRegistry()),
    ).resolves.toEqual({
      status: "failed",
      code: "PLATFORM_AUTOMATION_ACQ_SWEEP_WRITER_UNAVAILABLE",
    });
  });

  it("fails an enabled row as QUOTE_UNAVAILABLE when service authentication is absent", async () => {
    const report = await inspectPlatformBudgetAuthorityReadiness(
      platformSource(),
      platformRegistry({ includeQuoteAuthentication: false }),
    );

    expect(report.rows[0]).toMatchObject({
      state: "QUOTE_UNAVAILABLE",
      code: "PLATFORM_AUTOMATION_ACQ_SWEEP_QUOTE_UNAVAILABLE",
    });
  });

  it("publishes four exact schedule rows and keeps the pre-4D egress fence closed", async () => {
    const source = platformSource();

    await expect(
      inspectPlatformBudgetAuthorityReadiness(source, platformRegistry()),
    ).resolves.toMatchObject({
      status: "not_ready",
      rows: [
        { identity: { scheduleId: "acq-sweep" }, state: "BLOCKED" },
        {
          identity: { scheduleId: "patents-cache-refresh" },
          state: "INTENTIONALLY_DISABLED_NO_EGRESS",
        },
        { identity: { scheduleId: "intent-sweep" }, state: "BLOCKED" },
        { identity: { scheduleId: "sanctions-refresh" }, state: "BLOCKED" },
      ],
    });
    expect(source.inspectPlatformWriterCapability).toHaveBeenCalledTimes(3);
  });

  it("does not let a missing intent Temporal proof hide behind either acquisition row", async () => {
    const report = await inspectPlatformBudgetAuthorityReadiness(
      platformSource(),
      platformRegistry({
        omit: { fact: "temporal_proof", scheduleId: "intent-sweep" },
      }),
    );

    expect(
      report.rows.find((row) => row.identity.scheduleId === "intent-sweep"),
    ).toMatchObject({
      state: "TEMPORAL_PROOF_UNAVAILABLE",
      code: "PLATFORM_AUTOMATION_INTENT_SWEEP_TEMPORAL_PROOF_UNAVAILABLE",
    });
    expect(
      report.rows.filter(
        (row) => row.identity.purpose === "platform.acquisition",
      ),
    ).toHaveLength(2);
  });

  it.each([
    ["temporal_proof", "TEMPORAL_PROOF_UNAVAILABLE"],
    ["issuer", "ISSUER_UNAVAILABLE"],
    ["revocation_delivery", "REVOCATION_DELIVERY_UNAVAILABLE"],
  ] as const)(
    "maps a missing acq-sweep %s contributor to its approved exact state",
    async (fact, expectedState) => {
      const report = await inspectPlatformBudgetAuthorityReadiness(
        platformSource(),
        platformRegistry({ omit: { fact, scheduleId: "acq-sweep" } }),
      );

      expect(report.rows[0]).toMatchObject({
        identity: { scheduleId: "acq-sweep" },
        state: expectedState,
        code: `PLATFORM_AUTOMATION_ACQ_SWEEP_${expectedState}`,
      });
    },
  );

  it("bounds raw platform writer failures to the exact closed state", async () => {
    const source = {
      inspectPlatformWriterCapability: vi.fn(async () => {
        throw new Error("postgresql://writer:must-never-leak@db/platform");
      }),
    };
    const result = await checkPlatformBudgetAuthorityReadiness(
      source,
      platformRegistry(),
    );
    expect(result).toEqual({
      status: "failed",
      code: "PLATFORM_AUTOMATION_ACQ_SWEEP_WRITER_UNAVAILABLE",
    });
    expect(JSON.stringify(result)).not.toContain("must-never-leak");
  });

  it("registers and unregisters the additive authority contributors without probing on registration", async () => {
    const contributors = new Map<string, () => unknown>();
    const unregister = vi.fn();
    const registry = {
      register: vi.fn((name: string, contributor: () => unknown) => {
        contributors.set(name, contributor);
        return unregister;
      }),
    };
    const managed = new ManagedDependencyReadinessContributors(
      registry as never,
      { current: () => identity } as never,
    );
    managed.onModuleInit();
    expect(contributors.has("execution_budget_jwks")).toBe(true);
    expect(contributors.has("generic_artifact_storage")).toBe(true);
    expect(contributors.has("site_builder_model_settlement_readback")).toBe(
      true,
    );
    expect(contributors.has("platform_budget_authority")).toBe(false);
    expect(unregister).not.toHaveBeenCalled();
    vi.stubEnv("TOOL_RATE_LIMIT_REDIS_URL", "");
    vi.stubEnv("REDIS_URL", "");
    vi.stubEnv("MODEL_GATEWAY_URL", "");
    vi.stubEnv("MODEL_GATEWAY_KEY", "");
    vi.stubEnv("CHROME_PATH", "/not-an-allowed-browser");
    try {
      await expect(contributors.get("redis")?.()).resolves.toEqual({
        status: "failed",
        code: "REDIS_CONFIG_REQUIRED",
      });
      await expect(contributors.get("model_gateway")?.()).resolves.toEqual({
        status: "failed",
        code: "MODEL_GATEWAY_CONFIG_REQUIRED",
      });
      await expect(contributors.get("browser")?.()).resolves.toEqual({
        status: "failed",
        code: "BROWSER_RUNTIME_CONFIG_INVALID",
      });
      expect(contributors.get("renderer")?.()).toEqual({ status: "ok" });
    } finally {
      vi.unstubAllEnvs();
    }
    managed.onModuleDestroy();
    expect(unregister).toHaveBeenCalledTimes(contributors.size);

    const authorityRegistry = platformRegistry();
    const register = vi.spyOn(authorityRegistry, "register");
    const platform = new ExecutionBudgetAuthorityReadinessContributors(
      authorityRegistry,
      platformSource() as never,
    );
    platform.onModuleInit();
    expect(register).toHaveBeenCalledWith(
      "platform_budget_authority",
      expect.any(Function),
    );
    await expect(
      authorityRegistry.check("platform_budget_authority"),
    ).resolves.toEqual({
      status: "failed",
      code: "PLATFORM_AUTOMATION_ACQ_SWEEP_BLOCKED",
    });
    platform.onModuleDestroy();
    await expect(
      authorityRegistry.check("platform_budget_authority"),
    ).resolves.toEqual({
      status: "failed",
      code: "READINESS_CONTRIBUTOR_MISSING",
    });
  });

  it("fails artifact storage readiness before constructing a client when deployment config is incomplete", async () => {
    const factory = vi.fn();

    await expect(
      checkGenericArtifactStorageReadiness({}, factory),
    ).resolves.toEqual({
      status: "failed",
      code: "GENERIC_OPERATION_ARTIFACT_STORAGE_UNAVAILABLE",
    });
    expect(factory).not.toHaveBeenCalled();
  });

  it("delegates artifact storage readiness to the production S3 store contract and destroys its client", async () => {
    const checkReadiness = vi.fn(async () => ({ status: "ready" as const }));
    const checkLifecycleExtension = vi.fn(async () => true);
    const destroy = vi.fn();
    const factory = vi.fn(() => ({
      checkReadiness,
      checkLifecycleExtension,
      destroy,
    }));
    const env = {
      GENERIC_OPERATION_ARTIFACT_S3_ENDPOINT: "http://127.0.0.1:19000",
      GENERIC_OPERATION_ARTIFACT_S3_BUCKET: "global-operation-artifacts",
      GENERIC_OPERATION_ARTIFACT_S3_REGION: "us-east-1",
      GENERIC_OPERATION_ARTIFACT_S3_ACCESS_KEY: "runtime-artifact",
      GENERIC_OPERATION_ARTIFACT_S3_SECRET_KEY: "must-never-be-returned",
      GENERIC_OPERATION_ARTIFACT_S3_FORCE_PATH_STYLE: "true",
    };

    await expect(
      checkGenericArtifactStorageReadiness(env, factory),
    ).resolves.toEqual({
      status: "ok",
    });
    expect(factory).toHaveBeenCalledWith({
      endpoint: "http://127.0.0.1:19000/",
      bucket: "global-operation-artifacts",
      region: "us-east-1",
      accessKeyId: "runtime-artifact",
      secretAccessKey: "must-never-be-returned",
      forcePathStyle: true,
    });
    expect(checkReadiness).toHaveBeenCalledOnce();
    expect(checkLifecycleExtension).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("fails artifact storage readiness when the MinIO all-version expiry extension drifts", async () => {
    const factory = vi.fn(() => ({
      checkReadiness: vi.fn(async () => ({ status: "ready" as const })),
      checkLifecycleExtension: vi.fn(async () => false),
      destroy: vi.fn(),
    }));

    await expect(
      checkGenericArtifactStorageReadiness(
        {
          GENERIC_OPERATION_ARTIFACT_S3_ENDPOINT: "http://127.0.0.1:19000",
          GENERIC_OPERATION_ARTIFACT_S3_BUCKET: "global-operation-artifacts",
          GENERIC_OPERATION_ARTIFACT_S3_REGION: "us-east-1",
          GENERIC_OPERATION_ARTIFACT_S3_ACCESS_KEY: "runtime-artifact",
          GENERIC_OPERATION_ARTIFACT_S3_SECRET_KEY: "must-never-be-returned",
          GENERIC_OPERATION_ARTIFACT_S3_FORCE_PATH_STYLE: "true",
        },
        factory,
      ),
    ).resolves.toEqual({
      status: "failed",
      code: "GENERIC_OPERATION_ARTIFACT_STORAGE_UNAVAILABLE",
    });
  });

  it("holds Worker readiness when the Linux image decoder limiter is absent", async () => {
    await expect(
      checkImagePipelineIsolationReadiness("linux", async () => false),
    ).resolves.toEqual({
      status: "failed",
      code: "IMAGE_PIPELINE_ISOLATION_UNAVAILABLE",
    });
    await expect(
      checkImagePipelineIsolationReadiness("linux", async () => true),
    ).resolves.toEqual({
      status: "ok",
    });
  });

  it("requires an authoritative Redis PING and fails closed when config is missing", async () => {
    await expect(checkRedisReadiness({}, vi.fn())).resolves.toEqual({
      status: "failed",
      code: "REDIS_CONFIG_REQUIRED",
    });
    const client = {
      status: "wait",
      connect: vi.fn(async () => undefined),
      ping: vi.fn(async () => "PONG"),
      disconnect: vi.fn(),
    };
    await expect(
      checkRedisReadiness(
        { REDIS_URL: "redis://127.0.0.1:6379" },
        vi.fn(() => client),
      ),
    ).resolves.toEqual({ status: "ok" });
    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.ping).toHaveBeenCalledOnce();
    expect(client.disconnect).toHaveBeenCalledOnce();
  });

  it.each([
    "redis://cache.example.test:6379/0",
    "http://127.0.0.1:6379",
    "rediss://cache.example.test:6380/0?family=4",
    "rediss://cache.example.test:6380/0#private-fragment",
    "rediss://cache.example.test:6380/not-a-db",
  ])(
    "rejects an unsafe Redis URL before constructing a client: %s",
    async (url) => {
      const factory = vi.fn();
      const result = await checkRedisReadiness({ REDIS_URL: url }, factory);
      expect(result).toEqual({
        status: "failed",
        code: "REDIS_CONFIG_INVALID",
      });
      expect(factory).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain(url);
    },
  );

  it("allows credentials in a TLS URL but never returns them when the probe fails", async () => {
    const configured =
      "rediss://user:must-never-leak@cache.example.test:6380/0";
    const factory = vi.fn(() => {
      throw new Error(`failed ${configured}`);
    });
    const result = await checkRedisReadiness(
      { REDIS_URL: configured },
      factory,
    );
    expect(result).toEqual({ status: "failed", code: "REDIS_UNAVAILABLE" });
    expect(factory).toHaveBeenCalledWith(configured);
    expect(JSON.stringify(result)).not.toContain("must-never-leak");
  });

  it("uses only the no-generation model-list probe and bounds failures", async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      body: { cancel: vi.fn(async () => undefined) },
    }));
    await expect(
      checkModelGatewayReadiness(
        {
          MODEL_GATEWAY_URL: "http://127.0.0.1:3001/v1",
          MODEL_GATEWAY_KEY: "must-not-be-returned",
        },
        fetcher as never,
      ),
    ).resolves.toEqual({ status: "ok" });
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:3001/v1/models",
      expect.objectContaining({ method: "GET" }),
    );
    expect(
      JSON.stringify(await checkModelGatewayReadiness({}, fetcher as never)),
    ).not.toContain("must-not-be-returned");
  });

  it("never sends the gateway key to an unsafe probe origin", async () => {
    for (const url of [
      "http://gateway.example.test/v1",
      "https://user:password@gateway.example.test/v1",
      "https://gateway.example.test/v1?redirect=evil",
    ]) {
      const fetcher = vi.fn();
      const result = await checkModelGatewayReadiness(
        {
          MODEL_GATEWAY_URL: url,
          MODEL_GATEWAY_KEY: "never-dispatch-this-key",
        },
        fetcher,
      );
      expect(result).toEqual({
        status: "failed",
        code: "MODEL_GATEWAY_CONFIG_INVALID",
      });
      expect(fetcher).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain("never-dispatch-this-key");
    }
  });

  it("derives the renderer identity from the attested renderer component digest", () => {
    expect(rendererRuntimeIdentity(identity)).toBe(
      `site-renderer@${identity.renderer_digest}`,
    );
    expect(() =>
      rendererRuntimeIdentity({
        attested: false,
        schema_version: "global-runtime-release-identity/v1",
        code: "BUILD_ATTESTATION_REQUIRED",
      }),
    ).toThrow("RENDERER_IDENTITY_NOT_PROVEN");
  });

  it("launches only the fixed local Chromium binary with a zero-network data document", async () => {
    const probe = vi.fn(async () => undefined);
    await expect(checkBrowserReadiness({}, probe)).resolves.toEqual({
      status: "ok",
    });
    expect(probe).toHaveBeenCalledWith(
      "/usr/bin/chromium",
      expect.arrayContaining([
        "--headless=new",
        "--disable-background-networking",
        expect.stringMatching(/^data:text\/html,/),
      ]),
    );
    const unsafe = vi.fn();
    await expect(
      checkBrowserReadiness({ CHROME_PATH: "/tmp/downloaded-chrome" }, unsafe),
    ).resolves.toEqual({
      status: "failed",
      code: "BROWSER_RUNTIME_CONFIG_INVALID",
    });
    expect(unsafe).not.toHaveBeenCalled();
  });
});
