import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { sha256CanonicalJson } from "./eval-provenance";
import {
  buildDesignSpecV6NativeFeeCard,
  DESIGN_SPEC_V6_NATIVE_FEE_CARD_ID,
} from "./design-spec-v6-native-fee-card";

const manifest = Object.freeze(
  JSON.parse(
    readFileSync(
      join(
        __dirname,
        "../../../../../docs/evidence/site-builder/m1-g-design-spec-evaluation-manifest-v6.json",
      ),
      "utf8",
    ),
  ),
);
const { manifestSha256: _manifestSha256, ...manifestWithoutDigest } = manifest;
const evidence = Object.freeze(
  JSON.parse(
    readFileSync(
      join(
        __dirname,
        "../../../../../docs/evidence/site-builder/m1-g-design-spec-v6-native-fee-card-2026-08-04.json",
      ),
      "utf8",
    ),
  ),
);

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
    updated_at: "2026-08-04T00:00:00.000Z",
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

describe("design_spec v6 native-currency fee-card source contract", () => {
  it("binds only the merged v6 create-only manifest and exact target matrix", () => {
    const card = buildDesignSpecV6NativeFeeCard({
      manifest,
      catalog: catalog(),
      capturedAt: "2026-08-04T00:00:00.000Z",
      catalogResponseSha256: "a".repeat(64),
    });

    expect(card.fixedSourceCommitSha).toBe(
      "5c37bb9270db6893144f07c2431e74a830d6b9f4",
    );
    expect(card.feeCardId).toBe(DESIGN_SPEC_V6_NATIVE_FEE_CARD_ID);
    expect(card.manifestSha256).toBe(
      "1a74fab9ac803bfc50636fdb51ab7ac1b04623a8053c8d17a37a60294c99facd",
    );
    expect(card.suite).toEqual({
      suiteId: "site-builder.design-spec-evaluation-suite/2026-08-03-v15",
      sourceBundleContractId: "design-spec-evaluation-source-bundle/v15",
      sourceBundleSha256:
        "c6deda364bb15efe15d2237ea761573ba5501d8c10fd44578abd5926a2833e72",
    });
    expect(
      card.entries.reduce((sum, entry) => sum + entry.maximumWireCalls, 0),
    ).toBe(146);
  });

  it("keeps native currencies separate and remains not authorized", () => {
    const card = buildDesignSpecV6NativeFeeCard({
      manifest,
      catalog: catalog(),
      capturedAt: "2026-08-04T00:00:00.000Z",
      catalogResponseSha256: "a".repeat(64),
    });

    expect(card.status).toBe("READY_FOR_CREDENTIAL_ATTESTATION");
    expect(card.dispatchAuthorization).toBe("NOT_AUTHORIZED");
    expect(card.noForeignExchangeConversion).toBe(true);
    expect(card.expectedCost).toBe("not_known_before_usage");
    expect(JSON.stringify(card)).not.toContain("exchange");
  });

  it("records the public catalog result as zero-call, non-dispatch evidence", () => {
    expect(evidence).toMatchObject({
      schemaVersion: "site-builder-design-spec-v6-native-fee-card-evidence/v1",
      preparationCommitSha: "22f27678dcb75f2d7e5efc38b210de7756b34843",
      modelWireCalls: 0,
      actualModelCost: { CNY: "0", USD: "0" },
      dispatchAuthorization: "NOT_AUTHORIZED",
      card: {
        feeCardId: DESIGN_SPEC_V6_NATIVE_FEE_CARD_ID,
        fixedSourceCommitSha: "5c37bb9270db6893144f07c2431e74a830d6b9f4",
        manifestSha256:
          "1a74fab9ac803bfc50636fdb51ab7ac1b04623a8053c8d17a37a60294c99facd",
        totalsByCurrency: {
          CNY: { formatted: "11.276659" },
          USD: { formatted: "3.45842784" },
        },
        expectedCost: "not_known_before_usage",
        noForeignExchangeConversion: true,
      },
    });
  });

  it("rejects historical manifests and exact-matrix drift before pricing", () => {
    const historical = JSON.parse(
      readFileSync(
        join(
          __dirname,
          "../../../../../docs/evidence/site-builder/m1-g-design-spec-evaluation-manifest-v4.json",
        ),
        "utf8",
      ),
    );
    const executions = manifest.executions.map((entry, index) =>
      index === 0 ? { ...entry, protocol: "openai-chat-completions" } : entry,
    );
    const drifted = {
      ...manifest,
      executions,
      manifestSha256: sha256CanonicalJson({
        ...manifestWithoutDigest,
        executions,
      }),
    };

    expect(() =>
      buildDesignSpecV6NativeFeeCard({
        manifest: historical,
        catalog: catalog(),
        capturedAt: "2026-08-04T00:00:00.000Z",
        catalogResponseSha256: "a".repeat(64),
      }),
    ).toThrow("design_spec v6 manifest identity or envelope is invalid");
    expect(() =>
      buildDesignSpecV6NativeFeeCard({
        manifest: drifted,
        catalog: catalog(),
        capturedAt: "2026-08-04T00:00:00.000Z",
        catalogResponseSha256: "a".repeat(64),
      }),
    ).toThrow("design_spec v6 execution alias or protocol drifted");
  });
});
