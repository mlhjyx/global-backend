import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { settlementReadbackConfigured } from "../runtime/settlement-readback-config";
import { checkSiteBuildSettlementReadbackReadiness } from "../runtime/managed-dependency-readiness";
import { createSiteBuildSettlementReadbackRuntimeFromEnv } from "../site-builder/site-build-cost-reconciliation-resolver";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");

describe("M10-PR3: settlement readback decoupling and docker-compose openox-video-compat profile", () => {
  it("honors NEW_API_SETTLEMENT_READBACK_ENABLED=false kill switch and preserves default opt-in behavior", () => {
    expect(settlementReadbackConfigured({})).toBe(false);
    expect(
      settlementReadbackConfigured({
        MODEL_GATEWAY_SETTLEMENT_READBACK_CREDENTIAL:
          "srb1.abcdefghijklmnop.1234567890123456789012345678901234567890123",
      }),
    ).toBe(true);

    for (const disabled of ["false", "FALSE", "0", "off", "no"]) {
      expect(
        settlementReadbackConfigured({
          MODEL_GATEWAY_SETTLEMENT_READBACK_CREDENTIAL:
            "srb1.abcdefghijklmnop.1234567890123456789012345678901234567890123",
          NEW_API_SETTLEMENT_READBACK_ENABLED: disabled,
        }),
      ).toBe(false);
    }
  });

  it("removes eager top-level imports of new-api-request-bound-settlement from gateway, readiness, and resolver modules", () => {
    const files = [
      "apps/api/src/model-gateway/router-model-gateway.ts",
      "apps/api/src/model-gateway/providers/openai-compatible.provider.ts",
      "apps/api/src/model-gateway/provider-transport-observation.ts",
      "apps/api/src/runtime/managed-dependency-readiness.ts",
      "apps/api/src/site-builder/site-build-cost-reconciliation-resolver.ts",
    ];
    for (const relPath of files) {
      const source = readFileSync(resolve(REPO_ROOT, relPath), "utf8");
      expect(source, relPath).not.toMatch(
        /^\s*import\s+[^;]*from\s+["'][^"']*new-api-request-bound-settlement["']/m,
      );
    }
  });

  it("performs zero network probes and zero keyring reads when settlement readback is unconfigured or disabled", async () => {
    const fetchMock = vi.fn();
    const keyringLoader = vi.fn();

    await expect(
      checkSiteBuildSettlementReadbackReadiness(
        {},
        fetchMock as never,
        keyringLoader as never,
      ),
    ).resolves.toEqual({ status: "ok" });

    await expect(
      checkSiteBuildSettlementReadbackReadiness(
        {
          MODEL_GATEWAY_URL: "http://127.0.0.1:3001/v1",
          MODEL_GATEWAY_SETTLEMENT_READBACK_CREDENTIAL:
            "srb1.abcdefghijklmnop.1234567890123456789012345678901234567890123",
          SITE_BUILD_SETTLEMENT_DERIVATION_KEYRING_FILE: "/nonexistent/keyring",
          NEW_API_SETTLEMENT_READBACK_ENABLED: "false",
        },
        fetchMock as never,
        keyringLoader as never,
      ),
    ).resolves.toEqual({ status: "ok" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(keyringLoader).not.toHaveBeenCalled();

    const runtime = createSiteBuildSettlementReadbackRuntimeFromEnv(
      {} as never,
      {
        MODEL_GATEWAY_URL: "http://127.0.0.1:3001/v1",
        MODEL_GATEWAY_SETTLEMENT_READBACK_CREDENTIAL:
          "srb1.abcdefghijklmnop.1234567890123456789012345678901234567890123",
        SITE_BUILD_SETTLEMENT_DERIVATION_KEYRING_FILE: "/nonexistent/keyring",
        NEW_API_SETTLEMENT_READBACK_ENABLED: "false",
      },
    );
    expect(runtime).toBeUndefined();
  });

  it("lazily loads NewApiRequestBoundSettlementResolver when settlement readback IS configured", async () => {
    const fetchMock = vi.fn(async () =>
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
    const keyringLoader = vi.fn();

    const status = await checkSiteBuildSettlementReadbackReadiness(
      {
        MODEL_GATEWAY_URL: "http://127.0.0.1:3001/v1",
        MODEL_GATEWAY_KEY: "sk-dispatch-distinct-key",
        MODEL_GATEWAY_SETTLEMENT_READBACK_CREDENTIAL:
          "srb1.abcdefghijklmnop.1234567890123456789012345678901234567890123",
        SITE_BUILD_SETTLEMENT_DERIVATION_KEYRING_FILE:
          "/var/run/global/synthetic-keyring",
      },
      fetchMock as never,
      keyringLoader as never,
    );
    expect(keyringLoader).toHaveBeenCalledWith("/var/run/global/synthetic-keyring");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(status.status).toBe("ok");
  });

  it("places openox-video-compat under optional video-compat profile in docker-compose.yml while keeping service definition", () => {
    const compose = readFileSync(resolve(REPO_ROOT, "docker-compose.yml"), "utf8");
    const match = compose.match(
      /^ {2}openox-video-compat:\n([\s\S]*?)(?=^ {2}[a-z0-9_-]+:|\nvolumes:)/m,
    );
    expect(match).not.toBeNull();
    expect(match![1]).toMatch(/^\s+profiles:\s*\["video-compat"\]/m);
  });
});
