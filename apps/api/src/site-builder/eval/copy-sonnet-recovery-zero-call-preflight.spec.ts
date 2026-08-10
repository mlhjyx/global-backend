import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { canonicalDigest } from "../../model-runtime/context-engine";
import type { ExecutionBroker } from "../../tools/tool-contract";

import {
  COPY_SONNET_RECOVERY_ZERO_CALL_PREFLIGHT_OUTPUT_PATH,
  provisionAndAttestCopySonnetRecoveryZeroCall,
  validateCopySonnetRecoveryZeroCallPreflightArtifact,
} from "./copy-sonnet-recovery-zero-call-preflight";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../../../../");
const NOW = new Date("2026-08-10T06:00:00.000Z");
const ADMIN_ORIGIN = "http://127.0.0.1:3001";
const GATEWAY_ORIGIN = "http://127.0.0.1:3001";
const BINDING_BYTES = readFileSync(
  resolve(
    REPOSITORY_ROOT,
    "docs/evidence/site-builder/m1-g-copy-sonnet-recovery-runtime-binding-v16.json",
  ),
);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function catalog(options: {
  duplicateModel?: boolean;
  duplicateGroup?: boolean;
} = {}) {
  const model = {
    model_id: "claude-sonnet-5",
    product_line: "claude",
    input_rate: "2",
    output_rate: "10",
    cache_read_rate: "0.2",
    cache_write_rate: "2.5",
    group_rates: null,
    status: "enabled",
    updated_at: "2026-08-10T05:30:00.000Z",
  };
  const group = {
    name: "special",
    product_line: "claude",
    rate_multiplier: "1",
  };
  return {
    success: true,
    data: {
      models: options.duplicateModel ? [model, { ...model }] : [model],
      groups: options.duplicateGroup ? [group, { ...group }] : [group],
    },
  };
}

function pricingBroker(options: {
  duplicateModel?: boolean;
  duplicateGroup?: boolean;
} = {}) {
  const invoke = vi.fn(async () => ({
    data: {
      catalog: catalog(options),
      responseSha256: "a".repeat(64),
    },
    costCents: 0,
    provenance: {
      sourceUrl: "https://openox.tech/api/public/pricing-catalog",
      fetchedAt: NOW.toISOString(),
      contentHash: "a".repeat(64),
      parserVersion: "openox-pricing-catalog/1",
    },
  }));
  return {
    invoke,
    broker: {
      checkSourcePolicy: vi.fn(async () => ({ allowed: true })),
      invoke: invoke as unknown as ExecutionBroker["invoke"],
    } satisfies ExecutionBroker,
  };
}

function liveFetch(options: {
  existingPurposeToken?: boolean;
  broadenedModels?: boolean;
  duplicateChannels?: boolean;
  invalidLogShape?: boolean;
  postCreatePrefixToken?: boolean;
  invalidModelLimitValue?: boolean;
  malformedModelInventory?: boolean;
  missingPageTotal?: "channel" | "token";
  channelOverrides?: Record<string, unknown>;
  duplicatePricingModel?: boolean;
  duplicatePricingGroup?: boolean;
} = {}) {
  const observed: Array<{ method: string; path: string }> = [];
  const tokens: Array<Record<string, unknown>> = options.existingPurposeToken
    ? [
        {
          id: 19,
          name: "Site Builder Copy Sonnet Recovery v16",
          status: 1,
        },
      ]
    : [];
  const channel = {
    id: 22,
    name: "OpenOx Claude Sonnet",
    type: 14,
    status: 1,
    base_url: "https://openox.tech",
    models: "claude-sonnet-5",
    group: "special",
    model_mapping: "{}",
    ...options.channelOverrides,
  };
  const fetchMock = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      observed.push({ method, path: url.pathname });
      if (url.pathname === "/api/channel/") {
        return json({
          success: true,
          data: {
            items: options.duplicateChannels ? [channel, { ...channel, id: 23 }] : [channel],
            ...(options.missingPageTotal === "channel"
              ? {}
              : { total: options.duplicateChannels ? 2 : 1 }),
          },
        });
      }
      if (url.pathname === "/api/token/" && method === "GET") {
        if (
          options.postCreatePrefixToken &&
          tokens.some(({ id }) => id === 24) &&
          !tokens.some(({ id }) => id === 25)
        ) {
          tokens.push({
            ...tokens.find(({ id }) => id === 24),
            id: 25,
            name: "Site Builder Copy Sonnet Recovery v16-race",
            status: 1,
          });
        }
        return json({
          success: true,
          data: {
            items: tokens,
            ...(options.missingPageTotal === "token"
              ? {}
              : { total: tokens.length }),
          },
        });
      }
      if (url.pathname === "/api/token/" && method === "POST") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body).toMatchObject({
          name: "Site Builder Copy Sonnet Recovery v16",
          remain_quota: 186_080,
          unlimited_quota: false,
          model_limits_enabled: true,
          model_limits: "claude-sonnet-5",
          group: "special",
          cross_group_retry: false,
        });
        expect(body.expired_time).toBe(1_786_428_000);
        tokens.push({ id: 24, status: 1, ...body });
        return json({ success: true });
      }
      if (url.pathname === "/api/token/" && method === "PUT") {
        expect(url.searchParams.get("status_only")).toBe("true");
        const body = JSON.parse(String(init?.body)) as {
          id: number;
          status: number;
        };
        expect(body.status).toBe(2);
        expect([24, 25]).toContain(body.id);
        const token = tokens.find(({ id }) => id === body.id);
        if (token) token.status = body.status;
        return json({ success: true });
      }
      if (url.pathname === "/api/token/24/key" && method === "POST") {
        return json({ success: true, data: { key: "one-time-secret" } });
      }
      if (url.pathname === "/api/usage/token") {
        return json({
          data: {
            unlimited_quota: false,
            model_limits_enabled: true,
            model_limits: {
              "claude-sonnet-5": options.invalidModelLimitValue ? false : true,
            },
            total_granted: 186_080,
            total_available: 186_080,
          },
        });
      }
      if (url.pathname === "/v1/models") {
        return json({
          object: "list",
          data: [
            { id: "claude-sonnet-5", object: "model" },
            ...(options.malformedModelInventory ? [{}] : []),
            ...(options.broadenedModels
              ? [{ id: "gpt-5.6-terra", object: "model" }]
              : []),
          ],
        });
      }
      if (url.pathname === "/api/log/token") {
        return json(options.invalidLogShape ? { data: {} } : { data: [] });
      }
      if (
        url.origin === "https://openox.tech" &&
        url.pathname === "/api/public/pricing-catalog"
      ) {
        return json(
          catalog({
            duplicateModel: options.duplicatePricingModel,
            duplicateGroup: options.duplicatePricingGroup,
          }),
        );
      }
      throw new Error(`unexpected request ${method} ${url}`);
    },
  );
  return { fetchMock, observed };
}

function input(broker = pricingBroker().broker) {
  return {
    repositoryRoot: REPOSITORY_ROOT,
    executionHeadCommit: "ca16c5336a51f5ada152aff5c39e57ba8ff4589a",
    runtimeBindingBytes: BINDING_BYTES,
    adminBaseUrl: ADMIN_ORIGIN,
    gatewayOrigin: GATEWAY_ORIGIN,
    adminAccessToken: "admin-secret",
    adminUserId: 1,
    pricingBroker: broker,
  };
}

function runtimeDeps(fetchMock: typeof fetch) {
  return {
    fetch: fetchMock,
    now: () => NOW,
    readRepositoryState: () => ({
      head: "ca16c5336a51f5ada152aff5c39e57ba8ff4589a",
      clean: true,
    }),
    withExclusiveLock: async <T>(operation: () => Promise<T>) => operation(),
  };
}

describe("Copy Sonnet recovery zero-model-call preflight", () => {
  it("creates one 24h exact-scope finite token and attests route, quota, price and resolver readiness without dispatch", async () => {
    const live = liveFetch();
    const result = await provisionAndAttestCopySonnetRecoveryZeroCall(
      input(),
      runtimeDeps(live.fetchMock),
    );

    expect(COPY_SONNET_RECOVERY_ZERO_CALL_PREFLIGHT_OUTPUT_PATH).toBe(
      "docs/evidence/site-builder/m1-g-copy-sonnet-recovery-zero-call-preflight-v16.json",
    );
    expect(result.secret.tokenId).toBe(24);
    expect(result.secret.apiKey).toBe(["sk", "one", "time", "secret"].join("-"));
    expect(result.artifact).toMatchObject({
      schemaVersion:
        "site-builder-copy-sonnet-recovery-zero-call-preflight/2026-08-10-v1",
      artifactId:
        "site-builder-copy-sonnet-recovery-zero-call-preflight/2026-08-10-v16-v1",
      classification: "CONTROL_PLANE_ATTESTATION_ONLY",
      executionHeadCommit: "ca16c5336a51f5ada152aff5c39e57ba8ff4589a",
      preflightOnly: true,
      dispatchAuthorization: "NOT_AUTHORIZED",
      dispatchCapable: false,
      observedModelWireCalls: 0,
      observedModelCost: { CNY: 0, USD: 0 },
      runtimeBinding: {
        path: "docs/evidence/site-builder/m1-g-copy-sonnet-recovery-runtime-binding-v16.json",
        fileSha256:
          "a0b04862b538ae601b352a37d42eb8999ab67011d712d7d4dd765e6fa27ff6af",
        artifactDigest:
          "8a0b7c678026986d15cb4a4c953a50f100cbd48649671d8dbba64f9a87951cd0",
        compiledArtifactTreeDigest:
          "44e10f98e18a52d420e753b6be737acc1f5297908820f8809b00356bb2cd5afe",
      },
      credential: {
        purpose: "site_builder_copy_sonnet_recovery",
        tokenId: 24,
        bearerTokenSha256:
          "e98839495b40726d4193460951a0e4ee0d76f0e9772619275ded5db4d0017a9b",
        expiresAt: "2026-08-11T06:00:00.000Z",
        quotaMode: "limited",
        quotaCapPoints: 186_080,
        remainingQuotaPoints: 186_080,
        maximumQuotaPointsPerWire: 93_040,
      },
      executionScope: {
        taskId: "site_builder.copy",
        alias: "claude-sonnet-5",
        protocol: "anthropic_messages",
        transportProtocol: "anthropic-messages",
        reasoning: "medium",
        maximumExecutions: 1,
        maximumWireCalls: 2,
        maximumRepairCallsPerExecution: 1,
      },
      route: {
        channelId: 22,
        channelType: 14,
        baseUrl: "https://openox.tech",
        modelMapping: "IDENTITY",
        upstreamModelId: "claude-sonnet-5",
        group: "special",
      },
      pricing: {
        authority: "openox_model_marketplace",
        currency: "USD",
        inputPriceMicrounitsPerMillionTokens: 2_000_000,
        outputPriceMicrounitsPerMillionTokens: 10_000_000,
        cacheReadPriceMicrounitsPerMillionTokens: 200_000,
        cacheWritePriceMicrounitsPerMillionTokens: 2_500_000,
        maximumInputTokensPerWire: 69_632,
        maximumOutputTokensPerWire: 1_200,
        maximumNativeCostMicrounitsPerWire: 186_080,
        maximumNativeCostMicrounits: 372_160,
        quotaPerNativeUnit: 500_000,
      },
      settlement: {
        status: "READY_FOR_REQUEST_BOUND_OBSERVATION",
        logEndpoint: "/api/log/token",
        requestIdentityHeader: "x-oneapi-request-id",
        futurePhysicalCallSettlement:
          "UNPROVEN_UNTIL_SEPARATELY_AUTHORIZED_DISPATCH",
      },
    });
    expect(JSON.stringify(result.artifact)).not.toContain("one-time-secret");
    expect(() =>
      validateCopySonnetRecoveryZeroCallPreflightArtifact(result.artifact),
    ).not.toThrow();
    expect(live.observed.some(({ path }) => path === "/v1/messages")).toBe(false);
    expect(
      live.observed.some(({ path }) =>
        ["/v1/chat/completions", "/v1/responses"].includes(path),
      ),
    ).toBe(false);
    expect(result.artifact.controlPlaneObservation.requests).toEqual(
      expect.arrayContaining([
        {
          method: "GET",
          authority: "tool_broker",
          path: "/api/public/pricing-catalog",
        },
      ]),
    );
  });

  it("fails before creation when a purpose token already exists or route identity is ambiguous", async () => {
    for (const options of [
      { existingPurposeToken: true },
      { duplicateChannels: true },
    ]) {
      const live = liveFetch(options);
      await expect(
        provisionAndAttestCopySonnetRecoveryZeroCall(
          input(),
          runtimeDeps(live.fetchMock),
        ),
      ).rejects.toThrow(/COPY_SONNET_RECOVERY_(TOKEN_EXISTS|ROUTE_AMBIGUOUS)/u);
      expect(
        live.observed.some(
          ({ method, path }) => method === "POST" && path === "/api/token/",
        ),
      ).toBe(false);
    }
  });

  it("routes every OpenOx catalog read through the injected ToolBroker and records the broker authority", async () => {
    const live = liveFetch();
    const pricing = pricingBroker();
    const result = await provisionAndAttestCopySonnetRecoveryZeroCall(
      input(pricing.broker),
      runtimeDeps(live.fetchMock),
    );

    expect(pricing.invoke).toHaveBeenCalledTimes(2);
    expect(pricing.invoke).toHaveBeenCalledWith(
      "openox.pricing_catalog",
      {},
      expect.objectContaining({
        purpose: "site_builder_copy_sonnet_recovery",
      }),
    );
    expect(
      live.fetchMock.mock.calls.some(([request]) =>
        String(request).startsWith("https://openox.tech/"),
      ),
    ).toBe(false);
    expect(result.artifact.controlPlaneObservation.requests).toEqual(
      expect.arrayContaining([
        {
          method: "GET",
          authority: "tool_broker",
          path: "/api/public/pricing-catalog",
        },
      ]),
    );
  });

  it("uses manual redirect handling for every local control-plane request", async () => {
    const live = liveFetch();
    await provisionAndAttestCopySonnetRecoveryZeroCall(
      input(pricingBroker().broker),
      runtimeDeps(live.fetchMock),
    );

    expect(live.fetchMock).toHaveBeenCalled();
    for (const [, requestInit] of live.fetchMock.mock.calls) {
      expect(requestInit?.redirect).toBe("manual");
    }
  });

  it("rejects channel transport, OpenOx base URL, or model-mapping drift before token creation", async () => {
    for (const channelOverrides of [
      { type: 1 },
      { base_url: "https://proxy.example" },
      { model_mapping: JSON.stringify({ "claude-sonnet-5": "claude-opus-5" }) },
    ]) {
      const live = liveFetch({ channelOverrides });
      await expect(
        provisionAndAttestCopySonnetRecoveryZeroCall(
          input(pricingBroker().broker),
          runtimeDeps(live.fetchMock),
        ),
      ).rejects.toThrow("COPY_SONNET_RECOVERY_ROUTE_IDENTITY_INVALID");
      expect(
        live.observed.some(
          ({ method, path }) => method === "POST" && path === "/api/token/",
        ),
      ).toBe(false);
    }
  });

  it("rejects missing pagination totals before token creation", async () => {
    for (const missingPageTotal of ["channel", "token"] as const) {
      const live = liveFetch({ missingPageTotal });
      await expect(
        provisionAndAttestCopySonnetRecoveryZeroCall(
          input(pricingBroker().broker),
          runtimeDeps(live.fetchMock),
        ),
      ).rejects.toThrow("COPY_SONNET_RECOVERY_CONTROL_PLANE_RESPONSE_INVALID");
      expect(
        live.observed.some(
          ({ method, path }) => method === "POST" && path === "/api/token/",
        ),
      ).toBe(false);
    }
  });

  it("rejects duplicate OpenOx model or group rows before token creation", async () => {
    for (const duplicate of [
      { duplicatePricingModel: true },
      { duplicatePricingGroup: true },
    ]) {
      const live = liveFetch(duplicate);
      const pricing = pricingBroker({
        duplicateModel: duplicate.duplicatePricingModel,
        duplicateGroup: duplicate.duplicatePricingGroup,
      });
      await expect(
        provisionAndAttestCopySonnetRecoveryZeroCall(
          input(pricing.broker),
          runtimeDeps(live.fetchMock),
        ),
      ).rejects.toThrow("COPY_SONNET_RECOVERY_PRICE_INVALID");
      expect(
        live.observed.some(
          ({ method, path }) => method === "POST" && path === "/api/token/",
        ),
      ).toBe(false);
    }
  });

  it("rejects a dirty or mismatched execution head before any control-plane request", async () => {
    for (const state of [
      {
        head: "0".repeat(40),
        clean: true,
      },
      {
        head: "ca16c5336a51f5ada152aff5c39e57ba8ff4589a",
        clean: false,
      },
    ]) {
      const live = liveFetch();
      await expect(
        provisionAndAttestCopySonnetRecoveryZeroCall(input(), {
          ...runtimeDeps(live.fetchMock),
          readRepositoryState: () => state,
        }),
      ).rejects.toThrow("COPY_SONNET_RECOVERY_REPOSITORY_STATE_INVALID");
      expect(live.observed).toEqual([]);
    }
  });

  it("fails closed after creation on broadened live scope or unreadable settlement shape without any model request", async () => {
    for (const options of [
      { broadenedModels: true },
      { invalidLogShape: true },
      { invalidModelLimitValue: true },
      { malformedModelInventory: true },
    ]) {
      const live = liveFetch(options);
      await expect(
        provisionAndAttestCopySonnetRecoveryZeroCall(
          input(),
          runtimeDeps(live.fetchMock),
        ),
      ).rejects.toThrow(
        /COPY_SONNET_RECOVERY_(LIVE_SCOPE_INVALID|SETTLEMENT_PREFLIGHT_INVALID)/u,
      );
      expect(
        live.observed.some(({ path }) =>
          ["/v1/messages", "/v1/chat/completions", "/v1/responses"].includes(
            path,
          ),
        ),
      ).toBe(false);
      expect(
        live.observed.some(
          ({ method, path }) => method === "PUT" && path === "/api/token/",
        ),
      ).toBe(true);
    }
  });

  it("disables every active purpose-prefix token when a duplicate appears during creation", async () => {
    const live = liveFetch({ postCreatePrefixToken: true });
    await expect(
      provisionAndAttestCopySonnetRecoveryZeroCall(
        input(),
        runtimeDeps(live.fetchMock),
      ),
    ).rejects.toThrow("COPY_SONNET_RECOVERY_TOKEN_READBACK_INVALID");
    expect(
      live.observed.filter(
        ({ method, path }) => method === "PUT" && path === "/api/token/",
      ),
    ).toHaveLength(2);
    expect(
      live.observed.some(({ path }) =>
        ["/v1/messages", "/v1/chat/completions", "/v1/responses"].includes(
          path,
        ),
      ),
    ).toBe(false);
  });

  it("rejects authorization, wire-count, lifetime, digest or secret-bearing artifact drift", async () => {
    const live = liveFetch();
    const { artifact } = await provisionAndAttestCopySonnetRecoveryZeroCall(
      input(),
      runtimeDeps(live.fetchMock),
    );
    const { artifactDigest: _artifactDigest, ...understatedWithoutDigest } = {
      ...artifact,
      credential: {
        ...artifact.credential,
        quotaCapPoints: 2,
        remainingQuotaPoints: 2,
        maximumQuotaPointsPerWire: 1,
      },
      pricing: {
        ...artifact.pricing,
        maximumNativeCostMicrounitsPerWire: 1,
        maximumNativeCostMicrounits: 2,
      },
    };
    const understated = {
      ...understatedWithoutDigest,
      artifactDigest: canonicalDigest(understatedWithoutDigest),
    };
    for (const mutation of [
      { ...artifact, dispatchAuthorization: "AUTHORIZED" },
      { ...artifact, observedModelWireCalls: 1 },
      {
        ...artifact,
        credential: {
          ...artifact.credential,
          expiresAt: "2026-08-12T06:00:00.000Z",
        },
      },
      { ...artifact, artifactDigest: "0".repeat(64) },
      { ...artifact, bearerToken: "sk-forbidden" },
      understated,
    ]) {
      expect(() =>
        validateCopySonnetRecoveryZeroCallPreflightArtifact(mutation),
      ).toThrow("COPY_SONNET_RECOVERY_ZERO_CALL_ARTIFACT_INVALID");
    }

    for (const requiredRequest of [
      { authority: "new_api_admin", method: "GET", path: "/api/channel/" },
      { authority: "new_api_admin", method: "GET", path: "/api/token/" },
      { authority: "new_api_admin", method: "POST", path: "/api/token/" },
      { authority: "new_api_bearer", method: "GET", path: "/api/usage/token" },
      { authority: "new_api_bearer", method: "GET", path: "/v1/models" },
      { authority: "new_api_bearer", method: "GET", path: "/api/log/token" },
      { authority: "tool_broker", method: "GET", path: "/api/public/pricing-catalog" },
    ]) {
      const requests = artifact.controlPlaneObservation.requests.filter(
        (request) =>
          request.authority !== requiredRequest.authority ||
          request.method !== requiredRequest.method ||
          request.path !== requiredRequest.path,
      );
      const { artifactDigest: _digest, ...withoutDigest } = {
        ...artifact,
        controlPlaneObservation: {
          ...artifact.controlPlaneObservation,
          observedNetworkCalls: requests.length,
          requests,
        },
      };
      const missingRequiredObservation = {
        ...withoutDigest,
        artifactDigest: canonicalDigest(withoutDigest),
      };
      expect(() =>
        validateCopySonnetRecoveryZeroCallPreflightArtifact(
          missingRequiredObservation,
        ),
      ).toThrow("COPY_SONNET_RECOVERY_ZERO_CALL_ARTIFACT_INVALID");
    }
  });
});
