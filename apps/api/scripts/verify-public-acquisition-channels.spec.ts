import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("./verify-public-acquisition-channels.mts", import.meta.url),
);
const authorizationEnvironmentKey =
  "PUBLIC_ACQUISITION_ADAPTER_DIAGNOSTIC_AUTHORIZATION";

function runScript(
  input: { args?: string[]; environment?: Record<string, string> } = {},
) {
  const environment = { ...process.env, ...input.environment };
  delete environment[authorizationEnvironmentKey];
  Object.assign(environment, input.environment ?? {});
  return spawnSync(
    process.execPath,
    ["--import", "tsx", script, ...(input.args ?? [])],
    {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      env: environment,
      encoding: "utf8",
      timeout: 10_000,
    },
  );
}

describe("public acquisition adapter diagnostic safety contract", () => {
  it("declares adapter-only scope and never claims a persisted acquisition funnel", () => {
    const source = readFileSync(script, "utf8");

    expect(source).toContain("ADAPTER_RECORDS_OBSERVED");
    expect(source).toContain("adapter invocation and response parsing only");
    expect(source).toContain("neverProves");
    expect(source).toContain("RawSourceRecord");
    expect(source).toContain(
      "verify-world-bank-procurement-persistent-funnel.mts",
    );
    expect(source).not.toContain(
      "status: result.records.length > 0 ? 'OK_WITH_RECORDS' : 'ZERO_RESULT'",
    );
  });

  it("fails closed before any live adapter call when authorization is absent", () => {
    const result = runScript();

    expect(result.status).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe("");
    const report = JSON.parse(result.stderr) as {
      verdict: string;
      scope: string;
      neverProves: string[];
      results: unknown[];
    };
    expect(report.verdict).toBe("BLOCKED");
    expect(report.scope).toContain(
      "adapter invocation and response parsing only",
    );
    expect(report.neverProves).toContain("RawSourceRecord persistence");
    expect(report.results).toEqual([]);
  });

  it("does not accept a durable environment confirmation without the per-invocation flag", () => {
    const result = runScript({
      environment: {
        [authorizationEnvironmentKey]:
          "I_UNDERSTAND_THIS_IS_ADAPTER_ONLY_AND_MAKES_LIVE_REQUESTS",
      },
    });

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      verdict: "BLOCKED",
      results: [],
    });
  });

  it("requires exactly one provider selection even with the live confirmation and flag", () => {
    const result = runScript({
      args: ["--allow-live-adapter-diagnostic"],
      environment: {
        APP_ENVIRONMENT: "development",
        CI: "false",
        [authorizationEnvironmentKey]:
          "I_UNDERSTAND_THIS_IS_ADAPTER_ONLY_AND_MAKES_LIVE_REQUESTS",
      },
    });

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      verdict: "BLOCKED",
      authorization: {
        reason: "exactly one provider must be selected for this invocation",
      },
      results: [],
    });
  });

  it("rejects live diagnostics in staging or production before calling adapters", () => {
    for (const appEnvironment of ["staging", "production"]) {
      const result = runScript({
        args: ["--allow-live-adapter-diagnostic"],
        environment: {
          APP_ENVIRONMENT: appEnvironment,
          [authorizationEnvironmentKey]:
            "I_UNDERSTAND_THIS_IS_ADAPTER_ONLY_AND_MAKES_LIVE_REQUESTS",
        },
      });

      expect(result.status).toBe(1);
      expect(JSON.parse(result.stderr)).toMatchObject({
        verdict: "BLOCKED",
        authorization: { environment: appEnvironment },
        results: [],
      });
    }
  });

  it("rejects live diagnostics in CI before calling adapters", () => {
    const result = runScript({
      args: ["--allow-live-adapter-diagnostic", "--provider=nppes"],
      environment: {
        APP_ENVIRONMENT: "development",
        CI: "true",
        [authorizationEnvironmentKey]:
          "I_UNDERSTAND_THIS_IS_ADAPTER_ONLY_AND_MAKES_LIVE_REQUESTS",
      },
    });

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      verdict: "BLOCKED",
      authorization: {
        environment: "development",
        reason:
          "live adapter diagnostics are local-only and forbidden in CI, staging and production",
      },
      results: [],
    });
  });
});
