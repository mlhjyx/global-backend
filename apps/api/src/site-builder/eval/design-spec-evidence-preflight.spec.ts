import { describe, expect, it } from "vitest";

import {
  buildDesignSpecEvidencePreflight,
  renderDesignSpecEvidenceDecisionCard,
} from "./design-spec-evidence-preflight";

const aliases = [
  ["gpt-5.6-terra", "openai-responses"],
  ["gpt-5.5", "openai-responses"],
  ["claude-sonnet-5", "anthropic-messages"],
] as const;

function manifest(): Record<string, unknown> {
  const executions = Array.from({ length: 73 }, (_, index) => {
    const [alias, protocol] = aliases[index % aliases.length]!;
    return {
      kind: index === 0 ? "capability_probe" : "target",
      alias,
      protocol,
      maximumWireCalls: 2,
      maximumRepairCalls: 1,
    };
  });
  return {
    schemaVersion: "site-builder-design-spec-evaluation-manifest-prep/v1",
    taskId: "site_builder.design_spec",
    fixedCommitSha: "e493ba1d09fe37feea927f70d12f17aadadc5c6a",
    executionCount: 73,
    maximumWireCallCount: 146,
    promptUtf8Bytes: {
      maximumCanonicalInitial: 2342,
      maximumCanonicalRepair: 6649,
    },
    planningHardUpperBound: { perWireCallCents: 20, amountCents: 2920 },
    executions,
    suite: {
      suiteId: "site-builder.design-spec-evaluation-suite/2026-08-01-v14",
    },
  };
}

function catalog(): Record<string, unknown> {
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
    cache_read_rate: "0.25",
    cache_write_rate: "0",
    group_rates: null,
    status: "enabled",
    updated_at: "2026-08-01T10:39:45.303Z",
  });
  return {
    success: true,
    data: {
      models: [
        model("gpt-5.6-terra", "gpt", "2.5", "15"),
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

function input(overrides: Record<string, unknown> = {}) {
  return {
    manifest: manifest(),
    capturedAt: "2026-08-01T10:50:00.000Z",
    gatewayOrigin: "http://localhost:3001",
    credentialMaterial: "not_persisted",
    gatewayModels: { data: aliases.map(([id]) => ({ id })) },
    gatewayUsage: {
      data: {
        unlimited_quota: false,
        model_limits_enabled: true,
        total_granted: 1000,
        total_available: 900,
        model_limits: Object.fromEntries(aliases.map(([id]) => [id, 1000])),
      },
    },
    openOxCatalog: catalog(),
    openOxHttpStatus: 200,
    openOxResponseSha256: "b".repeat(64),
    readOnlyNetworkCalls: 3,
    sourceBundle: {
      commitSha: "f".repeat(40),
      contractId: "design-spec-evidence-preflight-source-bundle/v1",
      sha256: "c".repeat(64),
      files: [],
    },
    ...overrides,
  };
}

describe("design_spec evidence preflight", () => {
  it("prices only the selected OpenOx rows and admits an exact finite scope", () => {
    const report = buildDesignSpecEvidencePreflight(input());
    expect(report.status).toBe("READY_FOR_PRODUCT_DECISION");
    expect(report.dispatchAuthorization).toBe("NOT_AUTHORIZED");
    expect(report.readOnlyNetwork.modelWireCalls).toBe(0);
    expect(report.pricing.entries.map((entry) => entry.status)).toEqual([
      "published",
      "published",
      "published",
    ]);
    expect(report.credential.scopeExact).toBe(true);
    expect(report.estimate.maximumWireCallCount).toBe(146);
    expect(report.estimate.mechanicalHardCeilingCents).toBe(2920);
  });

  it("blocks an unlimited or unbounded gateway token without hiding price evidence", () => {
    const report = buildDesignSpecEvidencePreflight(
      input({
        gatewayUsage: {
          data: {
            unlimited_quota: true,
            model_limits_enabled: false,
            total_granted: 0,
            total_available: -1,
            model_limits: {},
          },
        },
      }),
    );
    expect(report.status).toBe("BLOCKED_CREDENTIAL_NOT_FINITE_EXACT");
    expect(report.blockers).toContain("CREDENTIAL_NOT_FINITE_EXACT");
    expect(
      report.pricing.entries.every((entry) => entry.status === "published"),
    ).toBe(true);
    expect(JSON.stringify(report)).not.toContain("Bearer");
  });

  it("fails closed when an OpenOx selected alias has no published row", () => {
    const broken = catalog();
    const data = broken.data as { models: unknown[]; groups: unknown[] };
    data.models = data.models.filter(
      (row) => (row as { model_id?: string }).model_id !== "gpt-5.5",
    );
    const report = buildDesignSpecEvidencePreflight(
      input({ openOxCatalog: broken }),
    );
    expect(report.status).toBe("BLOCKED_OPENOX_PRICE_MISSING");
    expect(report.blockers).toContain("OPENOX_PRICE_MISSING");
  });

  it("renders a decision card without raw credential material or model output", () => {
    const card = renderDesignSpecEvidenceDecisionCard(
      buildDesignSpecEvidencePreflight(input()),
    );
    expect(card).toContain("NOT_AUTHORIZED");
    expect(card).toContain("OpenOx");
    expect(card).not.toContain("response body");
    expect(card).not.toContain("Bearer ");
  });
});
