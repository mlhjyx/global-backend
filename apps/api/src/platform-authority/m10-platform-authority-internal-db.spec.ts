import "reflect-metadata";
import { BadRequestException, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import {
  isInternalDbPlatformAuthorityMode,
  PLATFORM_AUTHORITY_MODE_ENV,
  resolvePlatformAuthorityMode,
} from "./platform-authority-mode";
import {
  CANONICAL_PLATFORM_SCHEDULE_IDS,
  PlatformScheduleConfigError,
  PlatformScheduleConfigService,
  type PlatformScheduleConfigReaderDb,
  type PlatformScheduleConfigToggleAudit,
  type PlatformScheduleConfigWriterDb,
} from "./platform-schedule-config.service";
import {
  createInternalDbPlatformBudgetStore,
  inspectInternalDbPlatformAuthorityReadiness,
  InternalDbPlatformEgressFencePort,
  InternalDbPlatformScheduleAdmission,
  PLATFORM_SCHEDULE_DISABLED_BY_KILL_SWITCH,
} from "./internal-db-platform-authority";
import { PlatformEgressFence } from "./platform-egress-fence.v1";
import { tryProjectPlatformAutomationReadinessForHealth } from "./platform-automation-readiness-health";
import { PlatformCapabilityContributor } from "./platform-capability-contributor";
import {
  PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_READINESS_CONTRIBUTOR,
  PlatformTechnicalQuoteAuthenticationReadinessContributor,
  UnavailablePlatformTechnicalQuoteServiceAuthenticationVerifier,
} from "./platform-technical-quote-service-auth";
import {
  PLATFORM_SCHEDULE_CONFIG_SERVICE_TOKEN_ENV,
  PlatformScheduleConfigServiceTokenGuard,
} from "./platform-schedule-config-service-token.guard";
import { PlatformScheduleConfigInternalController } from "./platform-schedule-config-internal.controller";
import { RuntimeReadinessContributorRegistry } from "../runtime/runtime-readiness-registry";
import { inspectPlatformBudgetAuthorityReadiness } from "../runtime/managed-dependency-readiness";
import {
  parsePlatformExecutionBudgetBinding,
  PLATFORM_SCHEDULE_AUTHORITY_SCOPES,
  platformScheduleAccountKey,
} from "../temporal/platform-schedule-authority";
import { snapshotPlatformEgressOperation } from "./platform-egress-operation";

function createInMemoryScheduleStore(initial: Partial<Record<string, boolean>> = {}) {
  const rows = new Map<
    string,
    { scheduleId: string; enabled: boolean; updatedBy: string; updatedAt: Date }
  >();
  for (const id of CANONICAL_PLATFORM_SCHEDULE_IDS) {
    rows.set(id, {
      scheduleId: id,
      enabled: initial[id] ?? false,
      updatedBy: "migration",
      updatedAt: new Date("2026-11-26T00:00:00.000Z"),
    });
  }
  const reader: PlatformScheduleConfigReaderDb = {
    platformScheduleConfig: {
      findMany: vi.fn(async () =>
        [...rows.values()].sort((a, b) => a.scheduleId.localeCompare(b.scheduleId)),
      ),
      findUnique: vi.fn(async ({ where }) => rows.get(where.scheduleId) ?? null),
    },
  };
  const writer: PlatformScheduleConfigWriterDb = {
    platformScheduleConfig: {
      upsert: vi.fn(async ({ where, create, update }) => {
        const existing = rows.get(where.scheduleId);
        const next = existing
          ? { ...existing, ...update }
          : { ...create };
        rows.set(where.scheduleId, next);
        return next;
      }),
    },
  };
  return { rows, reader, writer };
}

describe("M10-PR3: PLATFORM_AUTHORITY_MODE=r4|internal_db and platform_schedule_config", () => {
  it("defaults PLATFORM_AUTHORITY_MODE to r4, parses internal_db, and fails closed on unknown values", () => {
    expect(resolvePlatformAuthorityMode({})).toBe("r4");
    expect(resolvePlatformAuthorityMode({ [PLATFORM_AUTHORITY_MODE_ENV]: "" })).toBe("r4");
    expect(resolvePlatformAuthorityMode({ [PLATFORM_AUTHORITY_MODE_ENV]: "R4" })).toBe("r4");
    expect(isInternalDbPlatformAuthorityMode({})).toBe(false);

    expect(
      resolvePlatformAuthorityMode({ [PLATFORM_AUTHORITY_MODE_ENV]: "internal_db" }),
    ).toBe("internal_db");
    expect(
      isInternalDbPlatformAuthorityMode({ [PLATFORM_AUTHORITY_MODE_ENV]: " INTERNAL_DB " }),
    ).toBe(true);

    expect(() =>
      resolvePlatformAuthorityMode({ [PLATFORM_AUTHORITY_MODE_ENV]: "bypass" }),
    ).toThrow(/PLATFORM_AUTHORITY_MODE_INVALID/);
  });

  it("reads, validates health, and toggles platform_schedule_config with structured audit", async () => {
    const store = createInMemoryScheduleStore();
    const audits: PlatformScheduleConfigToggleAudit[] = [];
    const service = new PlatformScheduleConfigService({
      reader: store.reader,
      writer: store.writer,
      env: { PLATFORM_AUTHORITY_MODE: "internal_db" },
      onAudit: (entry) => audits.push(entry),
    });

    const listed = await service.listAll();
    expect(listed).toHaveLength(4);
    expect(listed.every((row) => row.enabled === false)).toBe(true);
    await expect(service.assertHealthy()).resolves.toHaveLength(4);
    await expect(service.isEnabled("sanctions-refresh")).resolves.toBe(false);

    const toggled = await service.setEnabled({
      scheduleId: "sanctions-refresh",
      enabled: true,
      updatedBy: "ops-admin",
      reason: "enable daily sanctions refresh",
    });
    expect(toggled.config.enabled).toBe(true);
    expect(toggled.config.updatedBy).toBe("ops-admin");
    expect(toggled.audit).toMatchObject({
      scheduleId: "sanctions-refresh",
      previousEnabled: false,
      enabled: true,
      updatedBy: "ops-admin",
      reason: "enable daily sanctions refresh",
      mode: "internal_db",
    });
    expect(audits).toHaveLength(1);
    await expect(service.isEnabled("sanctions-refresh")).resolves.toBe(true);

    // Rejects invalid inputs and missing writer fail-closed
    await expect(
      service.setEnabled({
        scheduleId: "unknown-schedule",
        enabled: true,
        updatedBy: "ops-admin",
      }),
    ).rejects.toThrow(PlatformScheduleConfigError);
    await expect(
      service.setEnabled({
        scheduleId: "sanctions-refresh",
        enabled: false,
        updatedBy: "   ",
      }),
    ).rejects.toThrow(/PLATFORM_SCHEDULE_UPDATED_BY_INVALID/);

    const readOnlyService = new PlatformScheduleConfigService({
      reader: store.reader,
      writer: null,
    });
    await expect(
      readOnlyService.setEnabled({
        scheduleId: "sanctions-refresh",
        enabled: false,
        updatedBy: "ops-admin",
      }),
    ).rejects.toThrow(/PLATFORM_SCHEDULE_CONFIG_WRITER_UNAVAILABLE/);

    // Fails health check if any canonical schedule row is missing
    store.rows.delete("acq-sweep");
    await expect(service.assertHealthy()).rejects.toThrow(
      /PLATFORM_SCHEDULE_CONFIG_UNAVAILABLE/,
    );
  });

  it("reports healthy platform automation readiness in internal_db mode without R4 keys or binding files", async () => {
    const store = createInMemoryScheduleStore();
    const registry = new RuntimeReadinessContributorRegistry();

    // No R4 contributors registered in registry, no deployment-binding.json, no RSA keys!
    const report = await inspectPlatformBudgetAuthorityReadiness(
      undefined,
      registry,
      {
        env: { PLATFORM_AUTHORITY_MODE: "internal_db" },
        scheduleConfigReader: store.reader,
      },
    );
    expect(report.status).toBe("ready");
    expect(report.rows).toHaveLength(4);
    expect(tryProjectPlatformAutomationReadinessForHealth(report)).not.toBeNull();

    // Fails closed when DB table is missing rows or unreadable
    store.rows.delete("intent-sweep");
    const degraded = await inspectInternalDbPlatformAuthorityReadiness(
      new PlatformScheduleConfigService({ reader: store.reader }),
    );
    expect(degraded.status).toBe("not_ready");

    // Default r4 mode remains strict and fails without R4 contributors
    const r4Report = await inspectPlatformBudgetAuthorityReadiness(
      undefined,
      registry,
      { env: {} },
    );
    expect(r4Report.status).toBe("not_ready");
  });

  it("skips R4 capability polling and JWKS readiness failure in internal_db mode", async () => {
    vi.stubEnv("PLATFORM_AUTHORITY_MODE", "internal_db");
    try {
      const registry = new RuntimeReadinessContributorRegistry();
      const contributor = new PlatformCapabilityContributor(
        registry,
        {
          current: () => ({
            attested: true,
            build_sha: "a".repeat(40),
            artifact_digest: `sha256:${"b".repeat(64)}`,
            image_digest: `sha256:${"c".repeat(64)}`,
            renderer_digest: `sha256:${"d".repeat(64)}`,
            migration_revision: "20261126150000_platform_schedule_config",
          }),
        } as never,
        { current: () => ({ admitted: true }) } as never,
      );
      contributor.onModuleInit();
      // No R4 capability facts registered -> zero 7-day binding polling started
      expect(
        (await registry.check("platform_acq_sweep_issuer")).code,
      ).toBe("READINESS_CONTRIBUTOR_MISSING");
      contributor.onModuleDestroy();

      const quoteContributor =
        new PlatformTechnicalQuoteAuthenticationReadinessContributor(
          new UnavailablePlatformTechnicalQuoteServiceAuthenticationVerifier(),
          registry,
        );
      quoteContributor.onModuleInit();
      expect(
        await registry.check(
          PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_READINESS_CONTRIBUTOR,
        ),
      ).toEqual({ status: "ok" });
      quoteContributor.onModuleDestroy();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("enforces DB Kill Switch across admission, activity attestation, and mid-run egress fence", async () => {
    const store = createInMemoryScheduleStore({ "sanctions-refresh": false });
    const service = new PlatformScheduleConfigService({
      reader: store.reader,
      writer: store.writer,
      env: { PLATFORM_AUTHORITY_MODE: "internal_db" },
    });
    const admission = new InternalDbPlatformScheduleAdmission(service);
    const fence = new PlatformEgressFence(
      new InternalDbPlatformEgressFencePort(service),
    );
    const budgetStore = createInternalDbPlatformBudgetStore(service);

    const scope = PLATFORM_SCHEDULE_AUTHORITY_SCOPES["sanctions-refresh"];
    const workflowRunId = "11111111-1111-4111-8111-111111111111";
    const accountKey = platformScheduleAccountKey(scope, workflowRunId);

    // 1. Disabled in DB -> admission fails closed
    await expect(
      admission.admit({
        executionScope: scope,
        workflowId: "sanctions-refresh-run-1",
        workflowRunId,
      }),
    ).rejects.toThrow(PLATFORM_SCHEDULE_DISABLED_BY_KILL_SWITCH);

    // 2. Flip enabled=true -> admission, binding validation, attestation & egress succeed
    await service.setEnabled({
      scheduleId: "sanctions-refresh",
      enabled: true,
      updatedBy: "ops-admin",
    });
    const admitted = await admission.admit({
      executionScope: scope,
      workflowId: "sanctions-refresh-run-1",
      workflowRunId,
    });
    const binding = parsePlatformExecutionBudgetBinding({
      authorityId: admitted.authorityId,
      scopeKey: "platform",
      accountKey,
      ...scope,
      workflowRunId,
      admissionReplay: admitted.replay,
    });
    await expect(
      budgetStore.attestAuthorized({
        authorityId: binding.authorityId,
        scopeKey: binding.scopeKey,
        accountKey: binding.accountKey,
      }),
    ).resolves.toMatchObject({ authorityId: binding.authorityId });

    const op = snapshotPlatformEgressOperation({
      operationKey: "sanctions-ofac-1",
      budgetOperationId: "22222222-2222-4222-8222-222222222222",
      budgetOperationKey: "a".repeat(64),
      reservedMicrousd: 0n,
      execution: {
        kind: "tool",
        toolId: "sanctions.download",
        toolVersion: "1.0.0",
      },
    });
    const wire = vi.fn(async () => "ok");
    await expect(
      fence.authorizeAndDispatchPlatformEgress(
        {
          authorityId: binding.authorityId,
          scheduleId: binding.scheduleId,
          workflowId: "sanctions-refresh-run-1",
          workflowRunId,
          scheduleRequestSha256: binding.requestSha256,
          accountKey: binding.accountKey,
        },
        op,
        wire,
      ),
    ).resolves.toBe("ok");
    expect(wire).toHaveBeenCalledOnce();

    // 3. Mid-run Kill Switch flip to enabled=false -> next egress and attestation fail immediately
    await service.setEnabled({
      scheduleId: "sanctions-refresh",
      enabled: false,
      updatedBy: "ops-admin",
      reason: "emergency kill switch",
    });
    const blockedWire = vi.fn(async () => "must-not-run");
    await expect(
      fence.authorizeAndDispatchPlatformEgress(
        {
          authorityId: binding.authorityId,
          scheduleId: binding.scheduleId,
          workflowId: "sanctions-refresh-run-1",
          workflowRunId,
          scheduleRequestSha256: binding.requestSha256,
          accountKey: binding.accountKey,
        },
        op,
        blockedWire,
      ),
    ).rejects.toThrow(PLATFORM_SCHEDULE_DISABLED_BY_KILL_SWITCH);
    expect(blockedWire).not.toHaveBeenCalled();

    await expect(
      budgetStore.attestAuthorized!({
        authorityId: binding.authorityId,
        scopeKey: binding.scopeKey,
        accountKey: binding.accountKey,
      }),
    ).rejects.toThrow(PLATFORM_SCHEDULE_DISABLED_BY_KILL_SWITCH);
  });

  it("guards /internal/platform-schedules with constant-time service token and handles list/update", async () => {
    const guard = new PlatformScheduleConfigServiceTokenGuard();
    const makeCtx = (headers: Record<string, string>) =>
      ({
        switchToHttp: () => ({
          getRequest: () => ({ headers }),
        }),
      }) as never;

    vi.stubEnv(PLATFORM_SCHEDULE_CONFIG_SERVICE_TOKEN_ENV, "");
    expect(() => guard.canActivate(makeCtx({ "x-service-token": "abc" }))).toThrow(
      ServiceUnavailableException,
    );

    vi.stubEnv(PLATFORM_SCHEDULE_CONFIG_SERVICE_TOKEN_ENV, "super-secret-internal-token");
    try {
      expect(() => guard.canActivate(makeCtx({}))).toThrow(UnauthorizedException);
      expect(() =>
        guard.canActivate(makeCtx({ "x-service-token": "wrong-token" })),
      ).toThrow(UnauthorizedException);
      expect(
        guard.canActivate(
          makeCtx({ "x-service-token": "super-secret-internal-token" }),
        ),
      ).toBe(true);

      const store = createInMemoryScheduleStore();
      const service = new PlatformScheduleConfigService({
        reader: store.reader,
        writer: store.writer,
        env: { PLATFORM_AUTHORITY_MODE: "internal_db" },
      });
      const controller = new PlatformScheduleConfigInternalController(service);

      vi.stubEnv("PLATFORM_AUTHORITY_MODE", "internal_db");
      const listed = await controller.list();
      expect(listed.data.mode).toBe("internal_db");
      expect(listed.data.schedules).toHaveLength(4);

      const updated = await controller.update("acq-sweep", {
        enabled: true,
        updatedBy: "ops-cli",
        reason: "smoke test",
      });
      expect(updated.data.config.scheduleId).toBe("acq-sweep");
      expect(updated.data.config.enabled).toBe(true);
      expect(updated.data.audit.previousEnabled).toBe(false);
      expect(updated.data.audit.updatedBy).toBe("ops-cli");

      await expect(
        controller.update("not-a-schedule", {
          enabled: true,
          updatedBy: "ops-cli",
        }),
      ).rejects.toThrow(BadRequestException);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
