import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { sha256CanonicalJson } from "./eval-provenance";
import { buildDesignSpecV2NativeFeeCard } from "./design-spec-v2-native-fee-card";

const manifest = Object.freeze(
  JSON.parse(
    readFileSync(
      join(
        __dirname,
        "../../../../../docs/evidence/site-builder/m1-g-design-spec-evaluation-manifest-v4.json",
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

describe("design_spec v2 native-currency fee-card source contract", () => {
  it("binds only the merged v2 create-only manifest and exact target matrix", () => {
    const card = buildDesignSpecV2NativeFeeCard({
      manifest,
      catalog: catalog(),
      capturedAt: "2026-08-03T00:00:00.000Z",
      catalogResponseSha256: "a".repeat(64),
    });

    expect(card.fixedSourceCommitSha).toBe(
      "e569ddcc46040397c976258f76a16b2ec24c31eb",
    );
    expect(card.feeCardId).toBe(
      "site-builder-design-spec-v4-native-fee-card/2026-08-03-v1",
    );
    expect(card.manifestSha256).toBe(
      "560334518f28ea3d6838614702f0f829b8873568aef277bc364c0e4c195a9305",
    );
    expect(card.suite).toEqual({
      suiteId: "site-builder.design-spec-evaluation-suite/2026-08-03-v15",
      sourceBundleContractId: "design-spec-evaluation-source-bundle/v15",
      sourceBundleSha256:
        "a2469fe1fb1522aa90de791506745341796e5b6bbb7e879e8128f26ef79e3e06",
    });
    expect(card.entries.map((entry) => entry.alias)).toEqual([
      "claude-sonnet-5",
      "gpt-5.5",
      "gpt-5.6-terra",
    ]);
    expect(
      card.entries.reduce((sum, entry) => sum + entry.maximumWireCalls, 0),
    ).toBe(146);
  });

  it("keeps CNY and USD maximums separate and remains not authorized", () => {
    const card = buildDesignSpecV2NativeFeeCard({
      manifest,
      catalog: catalog(),
      capturedAt: "2026-08-03T00:00:00.000Z",
      catalogResponseSha256: "a".repeat(64),
    });

    expect(card.status).toBe("READY_FOR_CREDENTIAL_ATTESTATION");
    expect(card.dispatchAuthorization).toBe("NOT_AUTHORIZED");
    expect(card.noForeignExchangeConversion).toBe(true);
    expect(card.totalsByCurrency).toEqual({
      CNY: { nativePicoUnits: "11276659000000", formatted: "11.276659" },
      USD: { nativePicoUnits: "3458427840000", formatted: "3.45842784" },
    });
    expect(JSON.stringify(card)).not.toContain("exchange");
  });

  it("rejects the historical v1 manifest even if it is presented with a valid digest", () => {
    const historical = JSON.parse(
      readFileSync(
        join(
          __dirname,
          "../../../../../docs/evidence/site-builder/m1-g-design-spec-evaluation-manifest-v1.json",
        ),
        "utf8",
      ),
    );

    expect(() =>
      buildDesignSpecV2NativeFeeCard({
        manifest: historical,
        catalog: catalog(),
        capturedAt: "2026-08-03T00:00:00.000Z",
        catalogResponseSha256: "a".repeat(64),
      }),
    ).toThrow("design_spec v2 manifest identity or envelope is invalid");
  });

  it("rejects a manifest that changes a target protocol or lacks a public price", () => {
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
    const incomplete = catalog();
    incomplete.data.models = incomplete.data.models.filter(
      (entry) => entry.model_id !== "gpt-5.5",
    );

    expect(() =>
      buildDesignSpecV2NativeFeeCard({
        manifest: broadened,
        catalog: catalog(),
        capturedAt: "2026-08-03T00:00:00.000Z",
        catalogResponseSha256: "a".repeat(64),
      }),
    ).toThrow("design_spec v2 execution alias or protocol drifted");
    expect(() =>
      buildDesignSpecV2NativeFeeCard({
        manifest,
        catalog: incomplete,
        capturedAt: "2026-08-03T00:00:00.000Z",
        catalogResponseSha256: "a".repeat(64),
      }),
    ).toThrow("OpenOx price is missing or unpublished: gpt-5.5");
  });
});
