import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { sha256CanonicalJson } from "./eval-provenance";
import { buildDesignSpecNativeFeeCard } from "./design-spec-native-fee-card";

const manifest = Object.freeze(
  JSON.parse(
    readFileSync(
      join(
        __dirname,
        "../../../../../docs/evidence/site-builder/m1-g-design-spec-evaluation-manifest-v1.json",
      ),
      "utf8",
    ),
  ),
);
const { manifestSha256: _manifestSha256, ...manifestWithoutDigest } = manifest;

function catalog() {
  const model = (
    model_id: string,
    product_line: string,
    input_rate: string,
    output_rate: string,
  ) => ({
    model_id,
    product_line,
    input_rate,
    output_rate,
    cache_read_rate: "0",
    cache_write_rate: "0",
    status: "enabled",
    updated_at: "2026-08-02T15:56:41.000Z",
  });
  return {
    success: true,
    data: {
      models: [
        model("gpt-5.6-terra", "gpt", "2", "12"),
        model("gpt-5.5", "gpt", "5", "30"),
        model("claude-sonnet-5", "claude", "2", "10"),
      ],
      groups: [
        { name: "gpt-unified", product_line: "gpt", rate_multiplier: "1" },
        { name: "special", product_line: "claude", rate_multiplier: "1.26" },
      ],
    },
  };
}

describe("design_spec native-currency fee card", () => {
  it("binds the committed manifest without widening its target matrix", () => {
    const card = buildDesignSpecNativeFeeCard({
      manifest,
      catalog: catalog(),
      capturedAt: "2026-08-03T00:00:00.000Z",
      catalogResponseSha256: "a".repeat(64),
    });

    expect(card.fixedSourceCommitSha).toBe(
      "e493ba1d09fe37feea927f70d12f17aadadc5c6a",
    );
    expect(card.manifestSha256).toBe(
      "83dedcb2057d4e375114c42b5c03becbc9b057b1bfa1f3fc511bfec600827e72",
    );
    expect(card.entries.map((entry) => entry.alias)).toEqual([
      "claude-sonnet-5",
      "gpt-5.5",
      "gpt-5.6-terra",
    ]);
    expect(
      card.entries.reduce((sum, entry) => sum + entry.maximumWireCalls, 0),
    ).toBe(146);
  });

  it("keeps the CNY and USD matrix maxima separate without a conversion", () => {
    const card = buildDesignSpecNativeFeeCard({
      manifest,
      catalog: catalog(),
      capturedAt: "2026-08-03T00:00:00.000Z",
      catalogResponseSha256: "a".repeat(64),
    });

    expect(card.status).toBe("READY_FOR_CREDENTIAL_ATTESTATION");
    expect(card.dispatchAuthorization).toBe("NOT_AUTHORIZED");
    expect(card.tokenEnvelope).toEqual({
      initialInputTokens: 6_438,
      repairInputTokens: 10_745,
      outputTokensPerWireCall: 4_000,
    });
    expect(card.entries).toEqual([
      expect.objectContaining({
        alias: "claude-sonnet-5",
        protocol: "anthropic-messages",
        currency: "USD",
        executionCount: 24,
        maximumWireCalls: 48,
        maximumCost: {
          nativePicoUnits: "3458427840000",
          formatted: "3.45842784",
        },
      }),
      expect.objectContaining({
        alias: "gpt-5.5",
        protocol: "openai-responses",
        currency: "CNY",
        executionCount: 25,
        maximumWireCalls: 50,
        maximumCost: {
          nativePicoUnits: "8147875000000",
          formatted: "8.147875",
        },
      }),
      expect.objectContaining({
        alias: "gpt-5.6-terra",
        protocol: "openai-responses",
        currency: "CNY",
        executionCount: 24,
        maximumWireCalls: 48,
        maximumCost: {
          nativePicoUnits: "3128784000000",
          formatted: "3.128784",
        },
      }),
    ]);
    expect(card.totalsByCurrency).toEqual({
      CNY: { nativePicoUnits: "11276659000000", formatted: "11.276659" },
      USD: { nativePicoUnits: "3458427840000", formatted: "3.45842784" },
    });
    expect(JSON.stringify(card)).not.toContain("exchange");
  });

  it("rejects a missing public price before issuing a fee card", () => {
    const incomplete = catalog();
    incomplete.data.models = incomplete.data.models.filter(
      (entry) => entry.model_id !== "gpt-5.5",
    );

    expect(() =>
      buildDesignSpecNativeFeeCard({
        manifest,
        catalog: incomplete,
        capturedAt: "2026-08-03T00:00:00.000Z",
        catalogResponseSha256: "a".repeat(64),
      }),
    ).toThrow("OpenOx price is missing or unpublished: gpt-5.5");
  });

  it("rejects an execution matrix that broadens a target protocol", () => {
    const executions = manifest.executions.map((entry, index) =>
      index === 0 ? { ...entry, protocol: "openai-chat-completions" } : entry,
    );
    const broadened = {
      ...manifest,
      executions,
      manifestSha256: sha256CanonicalJson({
        ...manifestWithoutDigest,
        executions,
      }),
    };

    expect(() =>
      buildDesignSpecNativeFeeCard({
        manifest: broadened,
        catalog: catalog(),
        capturedAt: "2026-08-03T00:00:00.000Z",
        catalogResponseSha256: "a".repeat(64),
      }),
    ).toThrow("design_spec execution alias or protocol drifted");
  });

  it("rejects a manifest that is not the exact create-only mainline design_spec prep", () => {
    const widened = {
      ...manifest,
      dispatchAuthorization: "AUTHORIZED",
      actualNetworkCalls: 1,
      manifestSha256: sha256CanonicalJson({
        ...manifestWithoutDigest,
        dispatchAuthorization: "AUTHORIZED",
        actualNetworkCalls: 1,
      }),
    };

    expect(() =>
      buildDesignSpecNativeFeeCard({
        manifest: widened,
        catalog: catalog(),
        capturedAt: "2026-08-03T00:00:00.000Z",
        catalogResponseSha256: "a".repeat(64),
      }),
    ).toThrow("design_spec manifest identity or envelope is invalid");
  });

  it("rejects a manifest that changes the fixed suite contract", () => {
    const changed = {
      ...manifest,
      suite: {
        ...manifest.suite,
        sourceBundleContractId: "design-spec-evaluation-source-bundle/v15",
      },
      manifestSha256: sha256CanonicalJson({
        ...manifestWithoutDigest,
        suite: {
          ...manifest.suite,
          sourceBundleContractId: "design-spec-evaluation-source-bundle/v15",
        },
      }),
    };

    expect(() =>
      buildDesignSpecNativeFeeCard({
        manifest: changed,
        catalog: catalog(),
        capturedAt: "2026-08-03T00:00:00.000Z",
        catalogResponseSha256: "a".repeat(64),
      }),
    ).toThrow("design_spec manifest identity or envelope is invalid");
  });

  it("rejects a manifest whose declared digest does not bind its matrix", () => {
    expect(() =>
      buildDesignSpecNativeFeeCard({
        manifest: { ...manifest, manifestSha256: "c".repeat(64) },
        catalog: catalog(),
        capturedAt: "2026-08-03T00:00:00.000Z",
        catalogResponseSha256: "a".repeat(64),
      }),
    ).toThrow("design_spec manifest digest drifted");
  });
});
