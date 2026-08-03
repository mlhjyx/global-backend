import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { sha256CanonicalJson } from "./eval-provenance";
import {
  buildDesignSpecV5NativeFeeCard,
  DESIGN_SPEC_V5_NATIVE_FEE_CARD_ID,
} from "./design-spec-v5-native-fee-card";

const manifest = Object.freeze(
  JSON.parse(
    readFileSync(
      join(
        __dirname,
        "../../../../../docs/evidence/site-builder/m1-g-design-spec-evaluation-manifest-v5.json",
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
        "../../../../../docs/evidence/site-builder/m1-g-design-spec-v5-native-fee-card-2026-08-04.json",
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

describe("design_spec v5 native-currency fee-card source contract", () => {
  it("binds only the merged v5 create-only manifest and exact target matrix", () => {
    const card = buildDesignSpecV5NativeFeeCard({
      manifest,
      catalog: catalog(),
      capturedAt: "2026-08-04T00:00:00.000Z",
      catalogResponseSha256: "a".repeat(64),
    });

    expect(card.fixedSourceCommitSha).toBe(
      "377f8a3ae983bad0e4ae43f767a4bc59d8f7d0a9",
    );
    expect(card.feeCardId).toBe(DESIGN_SPEC_V5_NATIVE_FEE_CARD_ID);
    expect(card.manifestSha256).toBe(
      "bcc0ac261f56a5c950e11483a3dc28f33ed678c626891367a45b6c1f56429dc4",
    );
    expect(card.suite).toEqual({
      suiteId: "site-builder.design-spec-evaluation-suite/2026-08-03-v15",
      sourceBundleContractId: "design-spec-evaluation-source-bundle/v15",
      sourceBundleSha256:
        "0a14c446ddb0527204b6c0a472597403aaf61998c1d12975595ae921ffd8e98d",
    });
    expect(
      card.entries.reduce((sum, entry) => sum + entry.maximumWireCalls, 0),
    ).toBe(146);
  });

  it("keeps native currencies separate and remains not authorized", () => {
    const card = buildDesignSpecV5NativeFeeCard({
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
      schemaVersion: "site-builder-design-spec-v5-native-fee-card-evidence/v1",
      preparationCommitSha: "0a32c1737c82f30c3f333fd48d77f572bf1e8318",
      modelWireCalls: 0,
      actualModelCost: { CNY: "0", USD: "0" },
      dispatchAuthorization: "NOT_AUTHORIZED",
      card: {
        feeCardId: DESIGN_SPEC_V5_NATIVE_FEE_CARD_ID,
        fixedSourceCommitSha: "377f8a3ae983bad0e4ae43f767a4bc59d8f7d0a9",
        manifestSha256:
          "bcc0ac261f56a5c950e11483a3dc28f33ed678c626891367a45b6c1f56429dc4",
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
      buildDesignSpecV5NativeFeeCard({
        manifest: historical,
        catalog: catalog(),
        capturedAt: "2026-08-04T00:00:00.000Z",
        catalogResponseSha256: "a".repeat(64),
      }),
    ).toThrow("design_spec v5 manifest identity or envelope is invalid");
    expect(() =>
      buildDesignSpecV5NativeFeeCard({
        manifest: drifted,
        catalog: catalog(),
        capturedAt: "2026-08-04T00:00:00.000Z",
        catalogResponseSha256: "a".repeat(64),
      }),
    ).toThrow("design_spec v5 execution alias or protocol drifted");
  });
});
