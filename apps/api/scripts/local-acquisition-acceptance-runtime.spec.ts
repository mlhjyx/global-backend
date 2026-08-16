import { describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import {
  assertAcceptanceRuntimeConfig,
  assertManagedPidCommand,
  buildAttestationBlockers,
  buildCurrentHeadAttestationBlockers,
  buildChildEnvironment,
  buildWorkerEnvironment,
  commandExitCode,
  buildOperationalStatus,
  buildProviderSwitchReport,
  buildSourcePolicyReport,
  parseRuntimeCommand,
  safeFailureEnvelope,
  serializePidState,
  shouldRetainPidState,
} from "./local-acquisition-acceptance-runtime.mts";

const ownerUrl =
  "postgresql://global:owner-secret@127.0.0.1:55432/global_identity_fresh2_acceptance";
const appUrl =
  "postgresql://app_user:app-secret@127.0.0.1:55432/global_identity_fresh2_acceptance";
const acceptanceEnv = {
  ACQUISITION_ACCEPTANCE_OWNER_DATABASE_URL: ownerUrl,
  ACQUISITION_ACCEPTANCE_APP_DATABASE_URL: appUrl,
};
const dotenvConfigImport = createRequire(import.meta.url).resolve("dotenv/config");

describe("local acquisition acceptance runtime launcher", () => {
  it("accepts only the closed start/status/stop command surface", () => {
    expect(parseRuntimeCommand(["start"])).toBe("start");
    expect(parseRuntimeCommand(["status"])).toBe("status");
    expect(parseRuntimeCommand(["stop"])).toBe("stop");
    expect(() => parseRuntimeCommand([])).toThrow(/start\|status\|stop/u);
    expect(() => parseRuntimeCommand(["status", "--json"])).toThrow(
      /start\|status\|stop/u,
    );
  });

  it("admits only the exact loopback fresh2 database and fixed local ports", () => {
    expect(
      assertAcceptanceRuntimeConfig({
        ...acceptanceEnv,
      }),
    ).toMatchObject({
      databaseName: "global_identity_fresh2_acceptance",
      databasePort: 55432,
      temporalAddress: "127.0.0.1:7234",
      apiOrigin: "http://127.0.0.1:3000",
    });

    expect(() =>
      assertAcceptanceRuntimeConfig({
        ACQUISITION_ACCEPTANCE_OWNER_DATABASE_URL: ownerUrl.replace(
          "55432",
          "5432",
        ),
        ACQUISITION_ACCEPTANCE_APP_DATABASE_URL: appUrl.replace(
          "55432",
          "5432",
        ),
      }),
    ).toThrow(/55432/u);
    expect(() =>
      assertAcceptanceRuntimeConfig({
        ACQUISITION_ACCEPTANCE_OWNER_DATABASE_URL: ownerUrl.replace(
          "127.0.0.1",
          "db.example.com",
        ),
        ACQUISITION_ACCEPTANCE_APP_DATABASE_URL: appUrl.replace(
          "127.0.0.1",
          "db.example.com",
        ),
      }),
    ).toThrow(/loopback/u);
    expect(() =>
      assertAcceptanceRuntimeConfig({
        ACQUISITION_ACCEPTANCE_OWNER_DATABASE_URL: ownerUrl,
        ACQUISITION_ACCEPTANCE_APP_DATABASE_URL: appUrl.replace(
          "fresh2_acceptance",
          "other_acceptance",
        ),
      }),
    ).toThrow(/global_identity_fresh2_acceptance/u);
    expect(() =>
      assertAcceptanceRuntimeConfig({
        DATABASE_URL: ownerUrl,
        APP_DATABASE_URL: appUrl,
      }),
    ).toThrow(/ACQUISITION_ACCEPTANCE_OWNER_DATABASE_URL/u);
    expect(() =>
      assertAcceptanceRuntimeConfig({
        ...acceptanceEnv,
        ACQUISITION_ACCEPTANCE_OWNER_DATABASE_URL: ownerUrl.replace(
          "global:owner-secret",
          "app_user:owner-secret",
        ),
      }),
    ).toThrow(/owner role global/u);
    expect(() =>
      assertAcceptanceRuntimeConfig({
        ...acceptanceEnv,
        ACQUISITION_ACCEPTANCE_APP_DATABASE_URL: appUrl.replace(
          "app_user:app-secret",
          "global:app-secret",
        ),
      }),
    ).toThrow(/app role app_user/u);
    expect(() =>
      assertAcceptanceRuntimeConfig({
        ...acceptanceEnv,
        ACQUISITION_ACCEPTANCE_OWNER_DATABASE_URL: `${ownerUrl}?sslmode=disable`,
      }),
    ).toThrow(/query parameters/u);
    expect(() =>
      assertAcceptanceRuntimeConfig({
        ...acceptanceEnv,
        ACQUISITION_ACCEPTANCE_APP_DATABASE_URL: `${appUrl}#unexpected`,
      }),
    ).toThrow(/fragment/u);
  });

  it("builds a process-only environment and disables webhook delivery without mutating input", () => {
    const input = {
      ...acceptanceEnv,
      PORT: "9999",
      TEMPORAL_ADDRESS: "remote.example:7233",
      SAAS_WEBHOOK_URL: "https://sink.example/hook",
      SAAS_WEBHOOK_SECRET: "webhook-secret",
      UNRELATED_API_TOKEN: "must-not-reach-child",
    };
    const config = assertAcceptanceRuntimeConfig(input);
    const child = buildChildEnvironment(input, config);

    expect(child).toMatchObject({
      DATABASE_URL: ownerUrl,
      APP_DATABASE_URL: appUrl,
      API_BIND_HOST: "127.0.0.1",
      PORT: "3000",
      TEMPORAL_ADDRESS: "127.0.0.1:7234",
      APP_ENVIRONMENT: "development",
      NODE_ENV: "development",
      AUTH_ALLOW_DEV_TOKENS: "true",
      MODEL_ALLOW_STUB: "true",
      DOTENV_CONFIG_PATH: "/dev/null",
      DOTENV_CONFIG_QUIET: "true",
    });
    expect(child).not.toHaveProperty("SAAS_WEBHOOK_URL");
    expect(child).not.toHaveProperty("SAAS_WEBHOOK_SECRET");
    expect(child).not.toHaveProperty(
      "ACQUISITION_ACCEPTANCE_OWNER_DATABASE_URL",
    );
    expect(child).not.toHaveProperty("ACQUISITION_ACCEPTANCE_APP_DATABASE_URL");
    expect(child).not.toHaveProperty("UNRELATED_API_TOKEN");
    expect(input.PORT).toBe("9999");
  });

  it("passes source credentials only to the Worker process environment", () => {
    const input = {
      ...acceptanceEnv,
      MEXICO_DENUE_TOKEN: " memory-only-token ",
      FMCSA_QCMOBILE_WEB_KEY: " memory-only-web-key ",
      KONEPS_SERVICE_KEY: " memory-only-service-key ",
      SERPER_API_KEY: " memory-only-serper-key ",
      BRAVE_SEARCH_API_KEY: " memory-only-brave-key ",
      PUBLIC_WEB_SEARCH_BACKENDS: " brave.search ",
    };
    const config = assertAcceptanceRuntimeConfig(input);
    expect(buildChildEnvironment(input, config)).not.toHaveProperty(
      "MEXICO_DENUE_TOKEN",
    );
    expect(buildChildEnvironment(input, config)).not.toHaveProperty(
      "FMCSA_QCMOBILE_WEB_KEY",
    );
    expect(buildChildEnvironment(input, config)).not.toHaveProperty(
      "KONEPS_SERVICE_KEY",
    );
    expect(buildChildEnvironment(input, config)).not.toHaveProperty(
      "PUBLIC_WEB_SEARCH_BACKENDS",
    );
    expect(buildChildEnvironment(input, config)).not.toHaveProperty(
      "SERPER_API_KEY",
    );
    expect(buildChildEnvironment(input, config)).not.toHaveProperty(
      "BRAVE_SEARCH_API_KEY",
    );
    expect(buildWorkerEnvironment(input, config)).toMatchObject({
      MEXICO_DENUE_TOKEN: "memory-only-token",
      FMCSA_QCMOBILE_WEB_KEY: "memory-only-web-key",
      KONEPS_SERVICE_KEY: "memory-only-service-key",
      SERPER_API_KEY: "memory-only-serper-key",
      BRAVE_SEARCH_API_KEY: "memory-only-brave-key",
      PUBLIC_WEB_SEARCH_BACKENDS: "brave.search",
    });
  });

  it("prevents a real child dotenv import from reloading API and search credentials", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "acquisition-dotenv-boundary-"));
    try {
      writeFileSync(
        resolve(directory, ".env"),
        [
          "SAAS_WEBHOOK_URL=https://sentinel.invalid/hook",
          "SAAS_WEBHOOK_SECRET=dotenv-webhook-secret",
          "UNRELATED_API_TOKEN=dotenv-api-token",
          "SERPER_API_KEY=dotenv-serper-key",
          "BRAVE_SEARCH_API_KEY=dotenv-brave-key",
        ].join("\n"),
        { encoding: "utf8", mode: 0o600 },
      );
      const config = assertAcceptanceRuntimeConfig(acceptanceEnv);
      const inspectedKeys = [
        "SAAS_WEBHOOK_URL",
        "SAAS_WEBHOOK_SECRET",
        "UNRELATED_API_TOKEN",
        "SERPER_API_KEY",
        "BRAVE_SEARCH_API_KEY",
      ];
      const probe = (env: NodeJS.ProcessEnv) =>
        spawnSync(
          process.execPath,
          [
            "--require",
            dotenvConfigImport,
            "--eval",
            `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(inspectedKeys)}.map((key) => [key, Object.hasOwn(process.env, key)]))))`,
          ],
          { cwd: directory, env, encoding: "utf8" },
        );

      const apiProbe = probe(buildChildEnvironment(acceptanceEnv, config));
      expect(apiProbe.status).toBe(0);
      expect(apiProbe.stderr).toBe("");
      expect(JSON.parse(apiProbe.stdout)).toEqual({
        SAAS_WEBHOOK_URL: false,
        SAAS_WEBHOOK_SECRET: false,
        UNRELATED_API_TOKEN: false,
        SERPER_API_KEY: false,
        BRAVE_SEARCH_API_KEY: false,
      });

      const workerProbe = probe(
        buildWorkerEnvironment(
          {
            ...acceptanceEnv,
            SERPER_API_KEY: "explicit-worker-serper-key",
            BRAVE_SEARCH_API_KEY: "explicit-worker-brave-key",
          },
          config,
        ),
      );
      expect(workerProbe.status).toBe(0);
      expect(workerProbe.stderr).toBe("");
      expect(JSON.parse(workerProbe.stdout)).toEqual({
        SAAS_WEBHOOK_URL: false,
        SAAS_WEBHOOK_SECRET: false,
        UNRELATED_API_TOKEN: false,
        SERPER_API_KEY: true,
        BRAVE_SEARCH_API_KEY: true,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails the shell command for not-ready status or unproven stop invariants", () => {
    expect(commandExitCode("status", { status: "ready" })).toBe(0);
    expect(commandExitCode("start", { status: "not_ready" })).toBe(1);
    expect(
      commandExitCode("stop", {
        stopped: true,
        finalInvariantBlockers: [],
      }),
    ).toBe(0);
    expect(
      commandExitCode("stop", {
        stopped: true,
        finalInvariantBlockers: ["provider_ror_must_remain_disabled"],
      }),
    ).toBe(1);
    expect(
      commandExitCode("stop", {
        stopped: false,
        finalInvariantBlockers: [],
      }),
    ).toBe(1);
  });

  it("requires a valid running receipt bound to current HEAD for operational success", () => {
    expect(
      buildCurrentHeadAttestationBlockers({
        runtimeAttested: false,
        buildShaMatchesHead: null,
      }),
    ).toEqual(["runtime_build_unattested"]);
    expect(
      buildCurrentHeadAttestationBlockers({
        runtimeAttested: true,
        buildShaMatchesHead: false,
      }),
    ).toEqual(["runtime_build_sha_mismatch"]);
    expect(
      buildCurrentHeadAttestationBlockers({
        runtimeAttested: true,
        buildShaMatchesHead: true,
      }),
    ).toEqual([]);

    const blocked = buildOperationalStatus({
      databaseBlockers: [],
      attestationBlockers: ["runtime_build_unattested"],
      temporalReachable: true,
      apiLive: true,
      apiReady: true,
      statePresent: true,
      processesManaged: true,
    });
    expect(blocked).toEqual({
      status: "not_ready",
      blockers: ["runtime_build_unattested"],
    });
    expect(commandExitCode("start", blocked)).toBe(1);
    expect(commandExitCode("status", blocked)).toBe(1);
  });

  it("consumes externally generated release evidence without generating a receipt", () => {
    const source = readFileSync(
      new URL("./local-acquisition-acceptance-runtime.mts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("generate-build-attestation.mts");
    expect(source).not.toMatch(/spawnSync\("pnpm", \["--filter", "@global\/api", "build"\]/u);
    expect(source).toContain("receiptGeneratedByLauncher: false");
  });

  it("keeps the database inspection query surface aligned with every tracked Provider and SourcePolicy", () => {
    const source = readFileSync(
      new URL("./local-acquisition-acceptance-runtime.mts", import.meta.url),
      "utf8",
    );
    for (const provider of [
      "eu_ecolabel",
      "sbir_sttr_companies",
      "koneps",
    ]) {
      expect(source.match(new RegExp(`'${provider}'`, "gu"))?.length ?? 0)
        .toBeGreaterThanOrEqual(1);
    }
    for (const domain of [
      "apps.data.env.service.ec.europa.eu",
      "api.www.sbir.gov",
      "apis.data.go.kr",
    ]) {
      expect(source.split(`'${domain}'`).length - 1)
        .toBeGreaterThanOrEqual(1);
    }
  });

  it("retains PID state until every managed process is confirmed stopped", () => {
    expect(shouldRetainPidState([])).toBe(false);
    expect(shouldRetainPidState([78227])).toBe(true);
  });

  it("never serializes URLs, credentials, or commands into PID state", () => {
    const serialized = serializePidState({
      schemaVersion: "local-acquisition-acceptance-runtime/v1",
      repositoryRoot: "/work/goodjob-acquisition-integration",
      startedAt: "2026-08-14T00:00:00.000Z",
      apiPid: 101,
      workerPid: 102,
    });
    expect(serialized).not.toContain("postgresql://");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("dist/main.js");
    expect(JSON.parse(serialized)).toEqual({
      schemaVersion: "local-acquisition-acceptance-runtime/v1",
      repositoryRoot: "/work/goodjob-acquisition-integration",
      startedAt: "2026-08-14T00:00:00.000Z",
      apiPid: 101,
      workerPid: 102,
    });
  });

  it("allows TERM only when ps reports the exact current-worktree dist entry", () => {
    const entry = "/work/goodjob-acquisition-integration/apps/api/dist/main.js";
    expect(() =>
      assertManagedPidCommand(`/usr/bin/node ${entry}`, entry),
    ).not.toThrow();
    expect(() =>
      assertManagedPidCommand(
        "/usr/bin/node /other/worktree/apps/api/dist/main.js",
        entry,
      ),
    ).toThrow(/current worktree dist/u);
    expect(() =>
      assertManagedPidCommand(`/usr/bin/node ${entry}.old`, entry),
    ).toThrow(/current worktree dist/u);
  });

  it("treats verification-only providers as disabled invariants", () => {
    const safeReport = buildProviderSwitchReport([
      { key: "nppes", status: "ENABLED" },
      { key: "world_bank_procurement", status: "ENABLED" },
      { key: "usaspending_awards", status: "ENABLED" },
      { key: "uk_contracts_finder", status: "ENABLED" },
      { key: "singapore_gebiz", status: "DISABLED" },
      { key: "brazil_pncp", status: "DISABLED" },
      { key: "ror", status: "DISABLED" },
      { key: "sec_edgar", status: "DISABLED" },
      { key: "mexico_denue", status: "DISABLED" },
      { key: "fmcsa_qcmobile", status: "DISABLED" },
      { key: "eu_ecolabel", status: "DISABLED" },
      { key: "sbir_sttr_companies", status: "DISABLED" },
      { key: "koneps", status: "DISABLED" },
    ]);
    expect(safeReport).toMatchObject({
      statuses: { sec_edgar: "DISABLED" },
      blockers: [],
    });
    expect(
      buildProviderSwitchReport([
        { key: "nppes", status: "DISABLED" },
        { key: "world_bank_procurement", status: "ENABLED" },
        { key: "usaspending_awards", status: "ENABLED" },
        { key: "uk_contracts_finder", status: "ENABLED" },
        { key: "singapore_gebiz", status: "DISABLED" },
        { key: "brazil_pncp", status: "DISABLED" },
        { key: "ror", status: "DISABLED" },
        { key: "sec_edgar", status: "DISABLED" },
        { key: "mexico_denue", status: "DISABLED" },
        { key: "fmcsa_qcmobile", status: "DISABLED" },
      ]).blockers,
    ).toContain("provider_nppes_must_be_enabled");

    expect(
      buildProviderSwitchReport([
        { key: "singapore_gebiz", status: "ENABLED" },
        { key: "brazil_pncp", status: "DISABLED" },
        { key: "ror", status: "ENABLED" },
        { key: "fmcsa_qcmobile", status: "DISABLED" },
      ]).blockers,
    ).toContain("provider_singapore_gebiz_must_remain_disabled");
    expect(
      buildProviderSwitchReport([
        { key: "singapore_gebiz", status: "DISABLED" },
        { key: "brazil_pncp", status: "DISABLED" },
        { key: "ror", status: "ENABLED" },
        { key: "sec_edgar", status: "DISABLED" },
        { key: "mexico_denue", status: "DISABLED" },
        { key: "fmcsa_qcmobile", status: "DISABLED" },
      ]).blockers,
    ).toContain("provider_ror_must_remain_disabled");
    expect(
      buildProviderSwitchReport([
        { key: "singapore_gebiz", status: "DISABLED" },
        { key: "brazil_pncp", status: "DISABLED" },
        { key: "ror", status: "DISABLED" },
        { key: "sec_edgar", status: "ENABLED" },
        { key: "mexico_denue", status: "DISABLED" },
        { key: "fmcsa_qcmobile", status: "DISABLED" },
      ]).blockers,
    ).toContain("provider_sec_edgar_must_remain_disabled");
    expect(
      buildProviderSwitchReport([
        { key: "singapore_gebiz", status: "DISABLED" },
        { key: "brazil_pncp", status: "DISABLED" },
        { key: "ror", status: "DISABLED" },
        { key: "sec_edgar", status: "DISABLED" },
        { key: "mexico_denue", status: "ENABLED" },
        { key: "fmcsa_qcmobile", status: "DISABLED" },
      ]).blockers,
    ).toContain("provider_mexico_denue_must_remain_disabled");
    expect(
      buildProviderSwitchReport([
        { key: "singapore_gebiz", status: "DISABLED" },
        { key: "brazil_pncp", status: "DISABLED" },
        { key: "ror", status: "DISABLED" },
        { key: "sec_edgar", status: "DISABLED" },
        { key: "mexico_denue", status: "DISABLED" },
        { key: "fmcsa_qcmobile", status: "ENABLED" },
      ]).blockers,
    ).toContain("provider_fmcsa_qcmobile_must_remain_disabled");
    expect(
      buildProviderSwitchReport([
        { key: "singapore_gebiz", status: "DISABLED" },
        { key: "brazil_pncp", status: "DISABLED" },
        { key: "ror", status: "DISABLED" },
        { key: "fmcsa_qcmobile", status: "DISABLED" },
      ]).blockers,
    ).toContain("provider_sec_edgar_must_remain_disabled");
  });

  it("requires every tracked channel policy with its approved purpose", () => {
    const rows = [
      [
        "npiregistry.cms.hhs.gov",
        "company_registry",
        true,
        ["discovery", "enrichment"],
      ],
      ["search.worldbank.org", "gov_opportunity", true, ["discovery"]],
      ["api.usaspending.gov", "gov_award", true, ["discovery"]],
      [
        "www.contractsfinder.service.gov.uk",
        "gov_opportunity",
        true,
        ["discovery"],
      ],
      ["data.gov.sg", "gov_award", true, ["discovery"]],
      ["pncp.gov.br", "gov_opportunity", true, ["discovery"]],
      ["api.ror.org", "company_registry", false, ["discovery"]],
      ["www.sec.gov", "company_registry", false, ["discovery"]],
      ["data.sec.gov", "company_registry", true, ["enrichment"]],
      ["www.inegi.org.mx", "company_registry", true, ["discovery"]],
      ["mobile.fmcsa.dot.gov", "company_registry", true, ["discovery"]],
      [
        "apps.data.env.service.ec.europa.eu",
        "certification",
        true,
        ["discovery"],
      ],
      ["api.www.sbir.gov", "gov_award", true, ["discovery"]],
      ["apis.data.go.kr", "gov_award", true, ["discovery"]],
    ].map(([domain, sourceType, personalData, allowedPurpose]) => ({
      domain: domain as string,
      sourceType: sourceType as string,
      accessMode: "api",
      reviewStatus: [
        "mobile.fmcsa.dot.gov",
        "api.www.sbir.gov",
        "apis.data.go.kr",
      ].includes(domain as string)
        ? "SUSPENDED"
        : "APPROVED",
      robotsStatus: "ALLOWS",
      termsStatus: [
        "mobile.fmcsa.dot.gov",
        "api.www.sbir.gov",
        "apis.data.go.kr",
      ].includes(domain as string)
        ? "UNREVIEWED"
        : "REVIEWED_OK",
      personalData: personalData as boolean,
      allowedPurpose: allowedPurpose as string[],
      retentionDays: 365,
    }));
    expect(buildSourcePolicyReport(rows)).toMatchObject({ blockers: [] });
    expect(
      buildSourcePolicyReport(
        rows
          .filter((row) => row.domain !== "api.usaspending.gov")
          .map((row) =>
            row.domain === "data.sec.gov"
              ? { ...row, allowedPurpose: ["enrichment", "discovery"] }
              : row,
          ),
      ).blockers,
    ).toEqual([
      "source_policy_api_usaspending_gov_missing",
      "source_policy_data_sec_gov_allowed_purpose_mismatch",
    ]);
    expect(
      buildSourcePolicyReport(
        rows.map((row) =>
          row.domain === "api.usaspending.gov"
            ? { ...row, personalData: false }
            : row,
        ),
      ).blockers,
    ).toEqual(["source_policy_api_usaspending_gov_personal_data_mismatch"]);
  });

  it("never emits dependency messages, DSNs, or sentinel secrets in failures", () => {
    const envelope = safeFailureEnvelope(
      new Error(
        "connect postgresql://global:sentinel-secret@127.0.0.1:55432/global_identity_fresh2_acceptance failed",
      ),
    );
    const serialized = JSON.stringify(envelope);
    expect(envelope).toEqual({
      status: "blocked",
      code: "acceptance_runtime_command_failed",
    });
    expect(serialized).not.toContain("postgresql://");
    expect(serialized).not.toContain("sentinel-secret");
  });

  it("reports unattested, dirty, exact-source, and procfs limitations without inventing a receipt", () => {
    expect(
      buildAttestationBlockers({
        gitClean: false,
        runtimeAttested: false,
        exactSourceProven: false,
        linuxProcfsAvailable: false,
      }),
    ).toEqual([
      "dirty_worktree",
      "runtime_build_unattested",
      "running_executable_exact_source_unproven",
      "linux_procfs_unavailable",
    ]);
  });

  it("keeps operational readiness separate from release attestation blockers", () => {
    expect(
      buildOperationalStatus({
        databaseBlockers: [],
        temporalReachable: true,
        apiLive: true,
        apiReady: true,
        statePresent: true,
        processesManaged: true,
      }),
    ).toEqual({ status: "ready", blockers: [] });
    expect(
      buildOperationalStatus({
        databaseBlockers: [],
        temporalReachable: true,
        apiLive: true,
        apiReady: true,
        statePresent: false,
        processesManaged: false,
      }),
    ).toEqual({ status: "not_ready", blockers: ["pid_state_missing"] });
  });
});
