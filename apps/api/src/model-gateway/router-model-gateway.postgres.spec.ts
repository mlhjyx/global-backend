import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ModelProvider } from "./model-provider";
import type { ModelRouter } from "./model-router";
import { RouterModelGateway } from "./router-model-gateway";
import {
  createSiteBuildProviderWireDatabaseFromEnv,
  type SiteBuildProviderWireWorkspaceDatabase,
} from "../site-builder/site-build-provider-wire.database";
import { SiteBuildCostLedger } from "../site-builder/site-build-cost-ledger";
import { createSiteBuildCostReconciliationCatalogFromEnv } from "../site-builder/site-build-cost-reconciliation-resolver";
import {
  parseSettlementDerivationKeyring,
  settlementWireIdentities,
} from "./settlement-wire-identity";

const OWNER_DATABASE_URL = process.env.DATABASE_URL?.trim();
const EXPECTED_MIGRATION =
  process.env.SITE_BUILD_PROVIDER_WIRE_EXPECTED_MIGRATION_REVISION?.trim();
const liveDatabaseIt =
  OWNER_DATABASE_URL &&
  process.env.APP_DATABASE_URL &&
  process.env.SITE_BUILD_PROVIDER_WIRE_DATABASE_URL &&
  EXPECTED_MIGRATION
    ? it
    : it.skip;

describe("RouterModelGateway provider-wire PostgreSQL composition", () => {
  let owner: PrismaClient | undefined;
  let providerWireDatabase:
    | (SiteBuildProviderWireWorkspaceDatabase & {
        checkReadiness(): Promise<unknown>;
        disconnect(): Promise<void>;
      })
    | undefined;

  beforeAll(async () => {
    if (!OWNER_DATABASE_URL || !EXPECTED_MIGRATION) return;
    owner = new PrismaClient({ datasourceUrl: OWNER_DATABASE_URL });
    await owner.$connect();
    providerWireDatabase = createSiteBuildProviderWireDatabaseFromEnv(
      process.env,
      undefined,
      EXPECTED_MIGRATION,
    );
  });

  afterAll(async () => {
    await providerWireDatabase?.disconnect();
    await owner?.$disconnect();
  });

  liveDatabaseIt("releases a pre-wire denial with zero network and exact relational truth", async () => {
    if (!owner || !providerWireDatabase) {
      throw new Error("live provider-wire database contract is unavailable");
    }
    await expect(providerWireDatabase.checkReadiness()).resolves.toEqual({
      status: "ok",
    });

    const workspaceId = randomUUID();
    const siteId = randomUUID();
    const buildRunId = randomUUID();
    const taskAttemptId = randomUUID();
    const fenceToken = randomUUID();
    const now = new Date();
    await owner.$transaction([
      owner.workspace.create({
        data: { id: workspaceId, name: "Router zero-call integration" },
      }),
      owner.site.create({
        data: {
          id: siteId,
          workspaceId,
          name: "Router zero-call site",
          slug: `router-zero-${randomBytes(8).toString("hex")}`,
          intake: {},
        },
      }),
    ]);
    await owner.siteBuildRun.create({
      data: {
        id: buildRunId,
        workspaceId,
        siteId,
        kind: "refurbish",
        status: "running",
      },
    });
    await owner.siteBuildBudgetGrant.create({
      data: {
        workspaceId,
        siteId,
        buildRunId,
        issuer: "https://control.example.test",
        audience: "global-backend:site-builder-budget",
        jti: randomUUID(),
        schemaVersion: "site-builder-budget-grant/v1",
        purpose: "site_builder.build_run",
        operation: "refurbish",
        requestSha256: randomBytes(32).toString("hex"),
        tokenSha256: randomBytes(32).toString("hex"),
        currency: "USD",
        unit: "microusd",
        capMicrousd: 5_000_000n,
        issuedAt: new Date(now.getTime() - 30_000),
        notBefore: new Date(now.getTime() - 20_000),
        expiresAt: new Date(now.getTime() + 240_000),
        consumedAt: now,
      },
    });
    await owner.siteBuildBudget.create({
      data: {
        buildRunId,
        workspaceId,
        siteId,
        capMicrousd: 5_000_000n,
      },
    });
    await owner.siteBuildTaskAttempt.create({
      data: {
        id: taskAttemptId,
        workspaceId,
        siteId,
        buildRunId,
        taskId: "site_builder.copy",
        status: "CLAIMED",
        attemptNo: 1,
        fenceToken,
        leaseUntil: new Date(now.getTime() + 600_000),
      },
    });

    const providerCall = vi.fn();
    const provider: ModelProvider = {
      id: "gateway",
      supports: () => true,
      health: async () => ({ healthy: true }),
      generateStructured: providerCall,
      generateText: vi.fn() as never,
      reviewVision: vi.fn() as never,
      embed: vi.fn() as never,
    };
    const gateway = new RouterModelGateway({
      route: () => [provider],
    } as unknown as ModelRouter);
    const executionLedger = new SiteBuildCostLedger({} as never, {
      providerWireDatabase,
    });
    gateway.paidLedger = executionLedger;
    gateway.costReconciliationCatalog =
      createSiteBuildCostReconciliationCatalogFromEnv({
        SITE_BUILD_COST_RECONCILIATION_CATALOG_JSON: JSON.stringify({
          schemaVersion: "site-build-cost-reconciliation-catalog/v1",
          catalogId: "router-zero-call-integration",
          resolverId: "new-api-request-bound-reconciliation-v1",
          pricingAuthority: "openox_model_marketplace",
          pricingSnapshotSha256: "a".repeat(64),
          pricingCurrency: "USD",
          ledgerMicrousdPerPricingUnit: 1_000_000,
          entries: [
            {
              providerId: "gateway",
              taskId: "site_builder.copy",
              alias: "gpt-5.6-terra",
              protocol: "openai-responses",
              expectedChannelId: 72,
              maxOutputTokensPerCall: 4_000,
              gatewayCredentialQuotaCapPoints: 2_000_000,
              inputPriceMicrounitsPerMillionTokens: 2_000_000,
              outputPriceMicrounitsPerMillionTokens: 10_000_000,
            },
          ],
        }),
      });
    const keyring = parseSettlementDerivationKeyring(
      Buffer.from(
        `schema=site-build-settlement-derivation-keyring/v1\n` +
          `settlement-test ACTIVE ${"A".repeat(43)}\n`,
      ),
    );
    gateway.settlementDerivationKeyring = keyring;
    gateway.settlementReadbackResolver = { resolve: vi.fn() } as never;

    await expect(
      gateway.generateStructured(
        {
          task: "site_builder.copy",
          model: "gpt-5.6-terra",
          prompt: "bounded",
          schema: { type: "object" },
          maxCostCents: 40,
          maxTokens: 1_000,
        },
        {
          workspaceId,
          runId: buildRunId,
          paidCost: {
            siteId,
            scopeKey: `${taskAttemptId}:fallback-0`,
            taskAttemptId,
            fenceToken,
          },
          authorizeExternalAction: async () => false,
        },
      ),
    ).rejects.toMatchObject({
      name: "ExternalActionDeniedError",
      callCount: 0,
    });
    expect(providerCall).not.toHaveBeenCalled();

    const rows = await owner.$queryRaw<
      Array<{
        spendStatus: string;
        costBasis: string;
        budgetCharge: bigint;
        callCount: number | null;
        wireState: string;
        dispatchStartedAt: Date | null;
        reserved: bigint;
        charged: bigint;
      }>
    >`SELECT s.status AS "spendStatus", s.cost_basis AS "costBasis",
              s.budget_charge_microusd AS "budgetCharge",
              s.call_count AS "callCount", w.state AS "wireState",
              w.dispatch_started_at AS "dispatchStartedAt",
              b.reserved_microusd AS reserved, b.charged_microusd AS charged
         FROM site_build_spend s
         JOIN site_build_provider_wire_attempt w ON w.spend_id=s.id
         JOIN site_build_budget b ON b.build_run_id=s.build_run_id
        WHERE s.build_run_id=${buildRunId}::uuid`;
    expect(rows).toEqual([
      {
        spendStatus: "RELEASED",
        costBasis: "not_incurred",
        budgetCharge: 0n,
        callCount: null,
        wireState: "NOT_DISPATCHED",
        dispatchStartedAt: null,
        reserved: 0n,
        charged: 0n,
      },
    ]);

    // A normal pre-dispatch release is terminal exact zero and needs no
    // reconciliation row. Recovery-only error codes are selected separately.
    const recoveryNow = new Date(Date.now() + 61_000);
    const recoveryLedger = new SiteBuildCostLedger(
      providerWireDatabase as never,
      {
        providerWireDatabase,
        now: () => recoveryNow,
      },
    );
    await expect(
      recoveryLedger.listPendingReconciliations(workspaceId),
    ).resolves.toEqual([]);

    // Simulate the distinct recovery crash window: the Spend transition
    // commits, then the process stops before appendReconciliation. Only the
    // recovery-specific error code remains selectable.
    const recoveryOperationKey = randomBytes(32).toString("hex");
    const recoveryIdentity = settlementWireIdentities(
      keyring,
      recoveryOperationKey,
      1,
    )[0]!;
    const recoveryScope = {
      workspaceId,
      siteId,
      buildRunId,
      taskAttemptId,
      fenceToken,
      operationKey: recoveryOperationKey,
      kind: "model" as const,
      taskId: "site_builder.copy",
      subject: "gpt-5.6-terra@gateway",
      reservationMicrousd: 800_000,
    };
    const recoveryReservation = await executionLedger.reserveModelOperation({
      ...recoveryScope,
      wire: {
        wireIdentity: recoveryIdentity,
        protocol: "openai-responses",
        requestedAlias: "gpt-5.6-terra",
        expectedChannelId: 72,
        promptUtf8Bytes: 100,
        maximumWireCalls: 2,
        actualMaxOutputTokens: 1_000,
        catalogMaxOutputTokens: 4_000,
        maximumQuotaPoints: 2_000_000,
        catalogId: "router-zero-call-integration",
        catalogSha256: "b".repeat(64),
        pricingSnapshotSha256: "a".repeat(64),
        inputPriceMicrounitsPerMillionTokens: 2_000_000,
        outputPriceMicrounitsPerMillionTokens: 10_000_000,
        ledgerMicrousdPerPricingUnit: 1_000_000,
      },
    });
    if (recoveryReservation.kind !== "execute") {
      throw new Error("recovery reservation did not execute");
    }
    await executionLedger.finalizeModelPhysicalWireNotDispatched({
      workspaceId,
      wireAttemptId: recoveryReservation.wireAttemptId,
    });
    await expect(
      executionLedger.completeProviderSpendReconciliation({
        workspaceId,
        siteId,
        buildRunId,
        spendId: recoveryReservation.spendId,
        resolverId: "new-api-request-bound-reconciliation-v1",
        observedAt: new Date(),
      }),
    ).resolves.toMatchObject({
      status: "RESOLVED",
      costBasis: "not_incurred",
      exactCostMicrousd: "0",
    });

    await expect(
      recoveryLedger.listPendingReconciliations(workspaceId),
    ).resolves.toEqual([
      expect.objectContaining({
        operationKey: recoveryOperationKey,
        wireState: "NOT_DISPATCHED",
        action: "RESOLVE",
      }),
    ]);
    await expect(
      recoveryLedger.runReconciliationSweep({
        workspaceId,
        resolve: (candidate) =>
          recoveryLedger.completeProviderSpendReconciliation({
            workspaceId: candidate.workspaceId,
            siteId: candidate.siteId,
            buildRunId: candidate.buildRunId,
            spendId: candidate.spendId,
            resolverId: candidate.resolverId,
            observedAt: recoveryNow,
          }),
      }),
    ).resolves.toEqual({ attempted: 1, resolved: 1 });
    const [recovered] = await owner.$queryRaw<
      Array<{ reconciliations: number; summaryEvents: number }>
    >`SELECT
         (SELECT count(*)::int FROM site_build_spend_reconciliation
           WHERE build_run_id=${buildRunId}::uuid) AS reconciliations,
         (SELECT count(*)::int FROM outbox_event
           WHERE aggregate_id=${buildRunId}
             AND event_type='SiteBuildCostSummaryUpdated') AS "summaryEvents"`;
    expect(recovered).toEqual({ reconciliations: 1, summaryEvents: 1 });
  });
});
