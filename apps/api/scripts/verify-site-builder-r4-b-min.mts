import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { AiTraceSink } from '../src/model-gateway/ai-trace.sink';
import { buildGatewayProvider } from '../src/model-gateway/model-providers.config';
import { ModelProviderRegistry } from '../src/model-gateway/model-provider.registry';
import { ModelRouter } from '../src/model-gateway/model-router';
import { RouterModelGateway } from '../src/model-gateway/router-model-gateway';
import { BuildsService } from '../src/site-builder/builds.service';
import {
  PaidCallDeniedError,
  PaidOperationUnknownError,
  SiteBuildCostLedger,
  paidOperationKey,
} from '../src/site-builder/site-build-cost-ledger';

const owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
const appA = new PrismaService();
const appB = new PrismaService();

const workspaceId = randomUUID();
const otherWorkspaceId = randomUUID();
const siteId = randomUUID();
const buildRunId = randomUUID();
const newApiBuildRunId = randomUUID();
const cancelledBuildRunId = randomUUID();

const scope = {
  workspaceId,
  siteId,
  buildRunId,
};

async function main(): Promise<void> {
  assert(process.env.DATABASE_URL, 'DATABASE_URL is required');
  assert(process.env.APP_DATABASE_URL, 'APP_DATABASE_URL is required');
  assert.notEqual(
    process.env.DATABASE_URL,
    process.env.APP_DATABASE_URL,
    'owner and app_user connections must differ',
  );

  await Promise.all([owner.$connect(), appA.$connect(), appB.$connect()]);
  try {
    await owner.workspace.createMany({
      data: [
        { id: workspaceId, name: 'r4-b verifier' },
        { id: otherWorkspaceId, name: 'r4-b verifier isolation' },
      ],
    });
    await owner.site.create({
      data: {
        id: siteId,
        workspaceId,
        name: 'R4-B verifier',
        slug: `r4-b-${siteId}`,
        intake: {},
      },
    });
    await owner.siteBuildRun.create({
      data: {
        id: buildRunId,
        workspaceId,
        siteId,
        kind: 'refurbish',
        status: 'running',
      },
    });
    await owner.siteBuildBudget.create({
      data: {
        workspaceId,
        siteId,
        buildRunId,
        capMicrousd: 1_000_000n,
      },
    });

    const ownCount = await appA.withWorkspace(workspaceId, (tx) =>
      tx.siteBuildBudget.count({ where: { buildRunId } }),
    );
    const isolatedCount = await appA.withWorkspace(otherWorkspaceId, (tx) =>
      tx.siteBuildBudget.count({ where: { buildRunId } }),
    );
    assert.equal(ownCount, 1, 'app_user must see its own budget through RLS');
    assert.equal(
      isolatedCount,
      0,
      'app_user must not see another workspace budget through RLS',
    );

    const ledgerA = new SiteBuildCostLedger(appA);
    const ledgerB = new SiteBuildCostLedger(appB);
    const concurrentOperation = {
      ...scope,
      operationKey: paidOperationKey([buildRunId, 'concurrent']),
      kind: 'model' as const,
      taskId: 'site_builder.brand_profile',
      subject: 'gpt-5.6-terra',
      reservationMicrousd: 100_000,
    };
    const concurrent = await Promise.allSettled([
      ledgerA.reserveOperation(concurrentOperation),
      ledgerB.reserveOperation(concurrentOperation),
    ]);
    assert.equal(
      concurrent.filter(
        (outcome) =>
          outcome.status === 'fulfilled' && outcome.value.kind === 'execute',
      ).length,
      1,
      'exactly one concurrent caller may execute',
    );
    assert.equal(
      concurrent.filter(
        (outcome) =>
          outcome.status === 'rejected' &&
          outcome.reason instanceof PaidOperationUnknownError,
      ).length,
      1,
      'the overlapping caller must fail closed as acknowledgement-unknown',
    );

    const afterConcurrent = await appA.withWorkspace(workspaceId, async (tx) =>
      Promise.all([
        tx.siteBuildBudget.findUniqueOrThrow({ where: { buildRunId } }),
        tx.siteBuildSpend.findUniqueOrThrow({
          where: {
            buildRunId_operationKey: {
              buildRunId,
              operationKey: concurrentOperation.operationKey,
            },
          },
        }),
      ]),
    );
    assert.equal(afterConcurrent[0].reservedMicrousd, 0n);
    assert.equal(afterConcurrent[0].chargedMicrousd, 100_000n);
    assert.equal(afterConcurrent[1].status, 'UNKNOWN');
    assert.equal(afterConcurrent[1].costBasis, 'unknown');

    const settledOperation = {
      ...scope,
      operationKey: paidOperationKey([buildRunId, 'settled']),
      kind: 'model' as const,
      taskId: 'site_builder.brand_profile',
      subject: 'gpt-5.6-terra',
      reservationMicrousd: 200_000,
    };
    assert.deepEqual(await ledgerA.reserveOperation(settledOperation), {
      kind: 'execute',
    });
    assert.equal(
      await ledgerA.settleOperation({
        scope: settledOperation,
        status: 'SUCCEEDED',
        measurement: {
          basis: 'token_pricing',
          budgetChargeMicrousd: 25_000,
          reportedCostMicrousd: null,
          calculatedCostMicrousd: 25_000,
          estimatedCostMicrousd: null,
          inputTokens: 100,
          outputTokens: 20,
          callCount: 1,
          meta: { verifier: true },
        },
        result: { data: { ok: true } },
      }),
      'SETTLED',
    );
    const replay = await ledgerB.reserveOperation(settledOperation);
    assert.equal(replay.kind, 'replay');
    if (replay.kind === 'replay') {
      assert.equal(replay.status, 'SUCCEEDED');
      assert.deepEqual(replay.result, { data: { ok: true } });
    }

    const denied = await ledgerA
      .reserveOperation({
        ...scope,
        operationKey: paidOperationKey([buildRunId, 'over-budget']),
        kind: 'tool',
        taskId: 'site_builder.brand_profile',
        subject: 'crawl4ai.fetch',
        reservationMicrousd: 2_000_000,
      })
      .catch((error: unknown) => error);
    assert(denied instanceof PaidCallDeniedError);
    assert.equal(denied.decision, 'DENIED_BUDGET_EXHAUSTED');

    const summary = await ledgerA.closeAndSummarize({
      ...scope,
      reason: 'run_failed',
    });
    assert.equal(summary.schemaVersion, 'site-builder-cost-summary/v1');
    assert.equal(summary.budget.paidCallsEnabled, false);
    assert.equal(summary.budget.disabledReason, 'budget_exhausted');
    assert.equal(summary.operations.unknown, 1);
    assert.equal(summary.operations.succeeded, 1);
    assert.equal(summary.totals.calculatedCostMicrousd, 25_000);
    assert.equal(summary.totals.unknownOperations, 1);

    await owner.siteBuildRun.update({
      where: { id: buildRunId },
      data: { status: 'failed', finishedAt: new Date() },
    });

    if (process.argv.includes('--new-api-smoke')) {
      await owner.siteBuildRun.create({
        data: {
          id: newApiBuildRunId,
          workspaceId,
          siteId,
          kind: 'refurbish',
          status: 'running',
        },
      });
      await owner.siteBuildBudget.create({
        data: {
          workspaceId,
          siteId,
          buildRunId: newApiBuildRunId,
          capMicrousd: 1_000_000n,
        },
      });

      const provider = buildGatewayProvider();
      assert(
        provider,
        'MODEL_GATEWAY_URL/KEY are required for --new-api-smoke',
      );
      const registry = new ModelProviderRegistry();
      registry.register(provider);
      const gateway = new RouterModelGateway(
        new ModelRouter(registry),
        new AiTraceSink(appA),
      );
      gateway.paidLedger = ledgerA;
      const result = await gateway.generateStructured<{ ok: boolean }>(
        {
          task: 'site_builder.brand_profile',
          prompt: 'Return exactly {"ok":true}.',
          schema: {
            type: 'object',
            required: ['ok'],
            properties: { ok: { type: 'boolean' } },
          },
          model: 'gpt-5.6-terra',
          maxTokens: 1_000,
          maxCostCents: 25,
        },
        {
          workspaceId,
          runId: newApiBuildRunId,
          paidCost: {
            siteId,
            scopeKey: 'r4-b-new-api-smoke',
          },
        },
      );
      assert.equal(result.data.ok, true);
      assert.equal(result.provider, 'gateway');

      const spend = await appA.withWorkspace(workspaceId, (tx) =>
        tx.siteBuildSpend.findFirstOrThrow({
          where: { buildRunId: newApiBuildRunId, kind: 'model' },
        }),
      );
      assert.equal(spend.status, 'SUCCEEDED');
      assert(
        spend.costBasis === 'provider_reported' ||
          spend.costBasis === 'token_pricing',
        `real new-api usage must settle as reported or token-priced, got ${spend.costBasis}`,
      );
      assert((spend.inputTokens ?? 0) > 0);
      assert((spend.outputTokens ?? 0) > 0);

      await ledgerA.closeAndSummarize({
        workspaceId,
        siteId,
        buildRunId: newApiBuildRunId,
        reason: 'run_succeeded',
      });
      await owner.siteBuildRun.update({
        where: { id: newApiBuildRunId },
        data: { status: 'succeeded', finishedAt: new Date() },
      });
      console.log(
        `[r4-b-min] real new-api paid gateway smoke passed: ${spend.costBasis}, usage persisted`,
      );
    }

    await owner.siteBuildRun.create({
      data: {
        id: cancelledBuildRunId,
        workspaceId,
        siteId,
        kind: 'refurbish',
        status: 'running',
      },
    });
    await owner.siteBuildBudget.create({
      data: {
        workspaceId,
        siteId,
        buildRunId: cancelledBuildRunId,
        capMicrousd: 1_000_000n,
      },
    });
    assert.deepEqual(
      await ledgerA.reserveOperation({
        workspaceId,
        siteId,
        buildRunId: cancelledBuildRunId,
        operationKey: paidOperationKey([
          cancelledBuildRunId,
          'pending-at-cancellation',
        ]),
        kind: 'model',
        taskId: 'site_builder.brand_profile',
        subject: 'gpt-5.6-terra',
        reservationMicrousd: 100_000,
      }),
      { kind: 'execute' },
    );
    const cancellationService = new BuildsService(appA, {
      cancelRefurbish: async () => ({ terminalStatus: 'cancelled' }),
    } as never);
    assert.deepEqual(
      await cancellationService.cancel(
        { workspaceId, userId: 'r4-b-verifier', roles: [] },
        cancelledBuildRunId,
      ),
      { buildId: cancelledBuildRunId, status: 'cancelled' },
    );
    const cancelledDenial = await ledgerA
      .reserveOperation({
        workspaceId,
        siteId,
        buildRunId: cancelledBuildRunId,
        operationKey: paidOperationKey([
          cancelledBuildRunId,
          'after-cancellation',
        ]),
        kind: 'model',
        taskId: 'site_builder.brand_profile',
        subject: 'gpt-5.6-terra',
        reservationMicrousd: 100_000,
      })
      .catch((error: unknown) => error);
    assert(cancelledDenial instanceof PaidCallDeniedError);
    const [cancelledBudget, cancelledRun, cancelledSpend] =
      await appA.withWorkspace(workspaceId, (tx) =>
        Promise.all([
          tx.siteBuildBudget.findUniqueOrThrow({
            where: { buildRunId: cancelledBuildRunId },
          }),
          tx.siteBuildRun.findUniqueOrThrow({
            where: { id: cancelledBuildRunId },
          }),
          tx.siteBuildSpend.findFirstOrThrow({
            where: { buildRunId: cancelledBuildRunId },
          }),
        ]),
      );
    const cancelledSummary = cancelledRun.costSummary as Record<
      string,
      unknown
    >;
    assert.equal(cancelledRun.status, 'cancelled');
    assert.equal(
      cancelledSummary.schemaVersion,
      'site-builder-cost-summary/v1',
    );
    assert.equal(cancelledBudget.paidCallsEnabled, false);
    assert.equal(cancelledBudget.disabledReason, 'cancellation_requested');
    assert.equal(cancelledBudget.reservedMicrousd, 0n);
    assert.equal(cancelledSpend.status, 'UNKNOWN');

    console.log(
      '[r4-b-min] real PostgreSQL verifier passed: RLS, concurrent reserve, ACK-unknown, replay, settle, budget/cancellation kill switches, terminal cancellation repair, v1 summary',
    );
  } finally {
    await owner.site
      .deleteMany({ where: { id: siteId } })
      .catch(() => undefined);
    await owner.workspace
      .deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } })
      .catch(() => undefined);
    await Promise.all([
      owner.$disconnect(),
      appA.$disconnect(),
      appB.$disconnect(),
    ]);
  }
}

await main();
