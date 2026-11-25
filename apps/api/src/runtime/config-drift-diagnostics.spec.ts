import { describe, expect, it, vi } from "vitest";
import {
  ConfigDriftDiagnosticsService,
  inspectConfigurationDrift,
} from "./config-drift-diagnostics";

describe("config-drift-diagnostics (four-way startup drift checks)", () => {
  it("detects DB vs env vs safety allowlist drift without ever leaking secret values", () => {
    const secretProspeo = "sk-prospeo-super-secret-value-9999";
    const secretFindymail = "sk-findymail-super-secret-value-8888";

    const report = inspectConfigurationDrift({
      env: {
        HUNTER_API_KEY: "sk-hunter-secret",
        PROSPEO_API_KEY: secretProspeo,
        FINDYMAIL_API_KEY: secretFindymail,
        MILLIONVERIFIER_API_KEY: "",
        ICP_INPUT_GUARDRAILS: "off",
        GATE_ENRICHMENT_TASK_WRITE_ENABLED: "on",
        MODEL_GATEWAY_URL: "http://172.18.0.5:3000/v1",
        TEMPORAL_CUSTOMER_BACKEND_MODE: "postgres_platform",
        TEMPORAL_CUSTOMER_NAMESPACE: "platform-automation",
      },
      dbProviders: [
        { key: "hunter", status: "ENABLED" },
        { key: "prospeo", status: "DISABLED" },
        { key: "millionverifier", status: "ENABLED" },
        { key: "findymail", status: "ENABLED" },
        { key: "emailable", status: "DISABLED" },
      ],
      now: new Date("2026-11-26T00:00:00.000Z"),
    });

    const codes = report.findings.map((f) => `${f.code}:${f.subject}`);
    expect(codes).toContain("ENV_PRESENT_DB_DISABLED:prospeo");
    expect(codes).toContain("DB_ENABLED_ENV_MISSING:millionverifier");
    expect(codes).toContain("ENV_PRESENT_UNSUPPORTED_BY_SAFETY:findymail");
    expect(codes).toContain("DB_ENABLED_UNSUPPORTED_BY_SAFETY:findymail");
    expect(codes).toContain("ICP_INPUT_GUARDRAILS_DISABLED:ICP_INPUT_GUARDRAILS");
    expect(codes).toContain(
      "GATE_ENRICHMENT_TASK_WRITE_ENABLED_NO_CONSUMER:GATE_ENRICHMENT_TASK_WRITE_ENABLED",
    );
    expect(codes).toContain("MODEL_GATEWAY_IP_LITERAL_DETECTED:MODEL_GATEWAY_URL");
    expect(codes).toContain("TEMPORAL_CUSTOMER_CONFIG_DRIFT:TEMPORAL_CUSTOMER_BACKEND_MODE");

    // Hard secret redaction assertion: neither secret value nor prefix/length leaks.
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(secretProspeo);
    expect(serialized).not.toContain(secretFindymail);
    expect(serialized).not.toContain("sk-hunter-secret");
  });

  it("reports zero warnings when DB, env, safety policy, gateway, and Temporal are aligned", () => {
    const report = inspectConfigurationDrift({
      env: {
        HUNTER_API_KEY: "present",
        PROSPEO_API_KEY: "present",
        MILLIONVERIFIER_API_KEY: "present",
        EMAILABLE_API_KEY: "present",
        SERPER_API_KEY: "present",
        EXA_API_KEY: "present",
        ICP_INPUT_GUARDRAILS: "on",
        MODEL_GATEWAY_URL: "http://global-new-api:3000/v1",
      },
      dbProviders: [
        { key: "hunter", status: "ENABLED" },
        { key: "prospeo", status: "ENABLED" },
        { key: "millionverifier", status: "ENABLED" },
        { key: "emailable", status: "ENABLED" },
        { key: "serper", status: "ENABLED" },
        { key: "exa", status: "ENABLED" },
      ],
    });

    expect(report.findings.filter((f) => f.severity === "warn")).toEqual([]);
    expect(report.flags.gateEnrichmentTaskWriteEnabled).toBe(false);
    expect(report.flags.customerTemporalMode).toBe("dev_sqlite");
  });

  it("stays non-blocking when data_provider DB read fails at startup", async () => {
    const prisma = {
      dataProvider: {
        findMany: vi.fn().mockRejectedValue(new Error("db connection refused")),
      },
    };
    const service = new ConfigDriftDiagnosticsService(prisma as never);
    const report = await service.runDiagnostics({
      FINDYMAIL_API_KEY: "present",
    });

    expect(report.dbStatusLoaded).toBe(false);
    expect(service.getLastReport()).toBe(report);
    expect(
      report.findings.some(
        (f) =>
          f.code === "ENV_PRESENT_UNSUPPORTED_BY_SAFETY" &&
          f.subject === "findymail",
      ),
    ).toBe(true);
  });
});
