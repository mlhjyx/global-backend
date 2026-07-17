/**
 * R3-B1 live verifier against the Ubuntu development PostgreSQL + Temporal.
 * Proves the production service path: request fingerprint, one durable BuildRun,
 * deterministic Temporal identity pair, same-key replay, mismatch rejection,
 * fail-closed unsupported scope, and persisted-identity cancellation.
 *
 * Run from apps/api:
 *   ALLOW_DEV_DB_VERIFIER=true \
 *   DATABASE_URL=postgresql://global:global@localhost:5432/global_dev \
 *   APP_DATABASE_URL=postgresql://app_user:app_pw@localhost:5432/global_dev \
 *   node --import tsx scripts/verify-site-builder-r3-b1.mts
 */
import 'dotenv/config';
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { WorkflowNotFoundError } from '@temporalio/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { TemporalClient } from '../src/temporal/temporal.client';
import { BuildsService } from '../src/site-builder/builds.service';
import { refurbishWorkflowId } from '../src/site-builder/refurbish-launcher';
import { TemporalRefurbishLauncher } from '../src/site-builder/temporal-refurbish-launcher';
import { previewRoot } from '../src/temporal/site-builder.activities';

function requireDevelopmentTargets(): void {
  if (
    process.env.ALLOW_DEV_DB_VERIFIER !== 'true' ||
    process.env.NODE_ENV === 'production'
  ) {
    throw new Error(
      'refusing R3-B1 verifier: require ALLOW_DEV_DB_VERIFIER=true and non-production NODE_ENV',
    );
  }
  for (const name of ['DATABASE_URL', 'APP_DATABASE_URL'] as const) {
    const raw = process.env[name];
    if (!raw) throw new Error(`${name} is required`);
    const target = new URL(raw);
    if (
      !['localhost', '127.0.0.1', '::1', '[::1]'].includes(
        target.hostname.toLowerCase(),
      ) ||
      target.pathname !== '/global_dev'
    ) {
      throw new Error(
        `refusing ${name} target ${target.hostname}${target.pathname}; require loopback/global_dev`,
      );
    }
  }
  const temporal = new URL(
    `tcp://${process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233'}`,
  );
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(temporal.hostname)) {
    throw new Error('refusing non-loopback Temporal target');
  }
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`);
  console.log(`  ✅ ${message}`);
}

function httpStatus(error: unknown): number | undefined {
  return (error as { getStatus?: () => number }).getStatus?.();
}

requireDevelopmentTargets();

const owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
const app = new PrismaService();
const temporal = new TemporalClient();
const workspaceId = randomUUID();
const siteId = randomUUID();
const competingSiteIds = [randomUUID(), randomUUID()];
const ctx = { userId: 'r3-b1-verifier', workspaceId, roles: [] };
let workflowId: string | undefined;
const workflowIds = new Set<string>();

try {
  await Promise.all([
    owner.$connect(),
    app.$connect(),
    temporal.onModuleInit(),
  ]);
  const [role] = await app.$queryRaw<
    Array<{ currentUser: string; isSuper: boolean; bypassRls: boolean }>
  >`SELECT current_user AS "currentUser", rolsuper AS "isSuper", rolbypassrls AS "bypassRls"
    FROM pg_roles WHERE rolname = current_user`;
  check(
    role?.currentUser === 'app_user' && !role.isSuper && !role.bypassRls,
    'service uses non-superuser app_user with FORCE RLS',
  );
  const [ownerRole] = await owner.$queryRaw<
    Array<{ isSuper: boolean; bypassRls: boolean }>
  >`SELECT rolsuper AS "isSuper", rolbypassrls AS "bypassRls"
    FROM pg_roles WHERE rolname = current_user`;
  check(
    Boolean(ownerRole?.isSuper || ownerRole?.bypassRls),
    'cleanup connection is an explicit owner/BYPASSRLS connection',
  );

  await owner.site.create({
    data: {
      id: siteId,
      workspaceId,
      name: 'R3-B1 live verifier',
      slug: `r3-b1-${siteId}`,
      intake: {},
    },
  });

  const launcher = new TemporalRefurbishLauncher(temporal);
  const builds = new BuildsService(app, launcher);
  const idempotencyKey = `r3-b1-${randomUUID()}`;

  console.log('① create + durable Temporal ACK');
  const created = await builds.create(ctx, siteId, {
    scope: 'site',
    options: { stylePreset: 'precision-light', locales: ['en'] },
    idempotencyKey,
  });
  const first = await app.withWorkspace(workspaceId, (tx) =>
    tx.siteBuildRun.findUniqueOrThrow({ where: { id: created.buildId } }),
  );
  workflowId = first.temporalWorkflowId ?? undefined;
  if (workflowId) workflowIds.add(workflowId);
  check(
    created.status === 'queued',
    'HTTP service returns the durable queued run',
  );
  check(
    first.temporalWorkflowId === `site-refurbish-${created.buildId}` &&
      Boolean(first.temporalRunId),
    'workflowId + firstExecutionRunId are both persisted before success',
  );
  const described = await temporal.client.workflow
    .getHandle(first.temporalWorkflowId!)
    .describe();
  check(
    (described.raw.workflowExecutionInfo?.firstRunId || described.runId) ===
      first.temporalRunId,
    'database Temporal identity matches the live execution-chain head',
  );

  console.log('② same-key replay + mismatch rejection');
  const replay = await builds.create(ctx, siteId, {
    scope: 'site',
    options: { stylePreset: 'precision-light', locales: ['EN'] },
    idempotencyKey,
  });
  check(
    replay.buildId === created.buildId,
    'normalized same request replays the original BuildRun',
  );
  const [runCount, keyCount] = await app.withWorkspace(
    workspaceId,
    async (tx) =>
      Promise.all([
        tx.siteBuildRun.count({ where: { siteId } }),
        tx.idempotencyKey.count({
          where: {
            workspaceId,
            endpoint: 'POST /api/v1/site-builder/sites/:id/builds',
            key: idempotencyKey,
          },
        }),
      ]),
  );
  check(
    runCount === 1 && keyCount === 1,
    'replay leaves exactly one BuildRun and one fingerprint ledger row',
  );

  const mismatch = await builds
    .create(ctx, siteId, {
      scope: 'site',
      options: { stylePreset: 'modern-industrial' },
      idempotencyKey,
    })
    .catch((error) => error);
  check(
    httpStatus(mismatch) === 409,
    'same key with a different request is rejected with 409',
  );

  const unavailable = await builds
    .create(ctx, siteId, { scope: 'page', targetId: 'home' })
    .catch((error) => error);
  check(
    httpStatus(unavailable) === 422,
    'valid-but-unimplemented page scope fails closed with 422',
  );

  console.log('③ persisted-identity cancel + terminal replay');
  const cancelled = await builds.cancel(ctx, created.buildId);
  check(cancelled.status === 'cancelled', 'cancel persists the terminal state');
  const afterCancel = await app.withWorkspace(workspaceId, (tx) =>
    tx.siteBuildRun.findUniqueOrThrow({ where: { id: created.buildId } }),
  );
  check(
    afterCancel.status === 'cancelled' &&
      afterCancel.temporalWorkflowId === first.temporalWorkflowId &&
      afterCancel.temporalRunId === first.temporalRunId,
    'cancellation preserves the acknowledged execution identity',
  );
  const terminalReplay = await builds.create(ctx, siteId, {
    scope: 'site',
    options: { stylePreset: 'precision-light', locales: ['en'] },
    idempotencyKey,
  });
  check(
    terminalReplay.buildId === created.buildId &&
      terminalReplay.status === 'cancelled',
    'same-key replay returns the original terminal result without a new execution',
  );

  console.log('④ cross-Site same-key concurrency');
  await owner.site.createMany({
    data: competingSiteIds.map((id, index) => ({
      id,
      workspaceId,
      name: `R3-B1 competing verifier ${index + 1}`,
      slug: `r3-b1-${id}`,
      intake: {},
    })),
  });
  const concurrentKey = `r3-b1-race-${randomUUID()}`;
  const concurrent = await Promise.allSettled(
    competingSiteIds.map((id) =>
      builds.create(ctx, id, {
        scope: 'site',
        idempotencyKey: concurrentKey,
      }),
    ),
  );
  const winner = concurrent.find(
    (
      result,
    ): result is PromiseFulfilledResult<{ buildId: string; status: string }> =>
      result.status === 'fulfilled',
  );
  const loser = concurrent.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  check(
    Boolean(winner) && httpStatus(loser?.reason) === 409,
    'cross-Site same key has one success and one stable 409 loser',
  );
  const [competingRuns, competingKeys] = await app.withWorkspace(
    workspaceId,
    async (tx) =>
      Promise.all([
        tx.siteBuildRun.count({ where: { siteId: { in: competingSiteIds } } }),
        tx.idempotencyKey.count({
          where: {
            workspaceId,
            endpoint: 'POST /api/v1/site-builder/sites/:id/builds',
            key: concurrentKey,
          },
        }),
      ]),
  );
  check(
    competingRuns === 1 && competingKeys === 1,
    'cross-Site race leaves one BuildRun and one ledger row',
  );
  if (winner) {
    const competingRun = await app.withWorkspace(workspaceId, (tx) =>
      tx.siteBuildRun.findUniqueOrThrow({
        where: { id: winner.value.buildId },
      }),
    );
    if (competingRun.temporalWorkflowId)
      workflowIds.add(competingRun.temporalWorkflowId);
    await builds.cancel(ctx, winner.value.buildId);
  }

  console.log('\nR3-B1 live development verification passed.');
} finally {
  const cleanupErrors: unknown[] = [];
  const fixtureSiteIds = [siteId, ...competingSiteIds];
  try {
    const fixtureRuns = await owner.siteBuildRun.findMany({
      where: { siteId: { in: fixtureSiteIds } },
      select: { id: true, temporalWorkflowId: true },
    });
    for (const run of fixtureRuns) {
      // Derive the identity even when Temporal start succeeded but DB ACK persistence failed.
      workflowIds.add(run.temporalWorkflowId ?? refurbishWorkflowId(run.id));
    }
  } catch (error) {
    cleanupErrors.push(error);
  }
  await Promise.all(
    [...workflowIds].map(async (id) => {
      try {
        await temporal.client.workflow
          .getHandle(id)
          .terminate('R3-B1 verifier cleanup');
      } catch (error) {
        // Closed/not-found is expected. Transport/auth/timeouts must fail cleanup loudly.
        if (!(error instanceof WorkflowNotFoundError))
          cleanupErrors.push(error);
      }
    }),
  );
  const cleanupTasks = [
    ...fixtureSiteIds.map((id) =>
      rm(path.join(previewRoot(), `r3-b1-${id}`), {
        recursive: true,
        force: true,
      }),
    ),
    owner.idempotencyKey.deleteMany({ where: { workspaceId } }),
    owner.site.deleteMany({ where: { id: { in: fixtureSiteIds } } }),
  ];
  for (const result of await Promise.allSettled(cleanupTasks)) {
    if (result.status === 'rejected') cleanupErrors.push(result.reason);
  }
  try {
    const [sitesLeft, runsLeft, keysLeft] = await Promise.all([
      owner.site.count({ where: { id: { in: fixtureSiteIds } } }),
      owner.siteBuildRun.count({ where: { siteId: { in: fixtureSiteIds } } }),
      owner.idempotencyKey.count({ where: { workspaceId } }),
    ]);
    check(
      sitesLeft === 0 && runsLeft === 0 && keysLeft === 0,
      'verifier fixtures were removed from the development database',
    );
  } catch (error) {
    cleanupErrors.push(error);
  }
  for (const result of await Promise.allSettled([
    owner.$disconnect(),
    app.$disconnect(),
    temporal.onModuleDestroy(),
  ])) {
    if (result.status === 'rejected') cleanupErrors.push(result.reason);
  }
  if (cleanupErrors.length > 0) {
    console.error('R3-B1 verifier cleanup failed', cleanupErrors);
    process.exitCode = 1;
  }
}
