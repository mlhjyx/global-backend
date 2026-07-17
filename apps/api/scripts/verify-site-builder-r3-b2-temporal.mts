/** Real Temporal + PostgreSQL R3-B2 verifier. Run only against an isolated development DB/namespace. */
import 'dotenv/config';
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { PrismaService } from '../src/prisma/prisma.service';
import { buildDemoSpec } from '../src/site-builder/demo-spec';
import { previewRoot } from '../src/temporal/site-builder.activities';
import { createSiteBuilderActivities } from '../src/temporal/site-builder.activities';

function guard(): void {
  if (
    process.env.ALLOW_DEV_DB_VERIFIER !== 'true' ||
    process.env.NODE_ENV === 'production'
  ) {
    throw new Error(
      'require ALLOW_DEV_DB_VERIFIER=true and non-production NODE_ENV',
    );
  }
  for (const name of ['DATABASE_URL', 'APP_DATABASE_URL'] as const) {
    const url = new URL(process.env[name] ?? '');
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) {
      throw new Error(`${name} must target loopback`);
    }
    if (!/^\/global_r3b2_verify(?:_|$)/.test(url.pathname)) {
      throw new Error(
        `${name} must target an isolated global_r3b2_verify database`,
      );
    }
  }
  if (!process.env.TEMPORAL_NAMESPACE?.startsWith('r3b2-verify-')) {
    throw new Error(
      'TEMPORAL_NAMESPACE must be an isolated r3b2-verify-* namespace',
    );
  }
}

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`assertion failed: ${message}`);
  console.log(`  ✅ ${message}`);
}

guard();
const owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
const app = new PrismaService();
const workspaceId = randomUUID();
const pageSiteId = randomUUID();
const cancelSiteId = randomUUID();
const pageRunId = randomUUID();
const cancelRunId = randomUUID();
const taskQueue = `r3b2-verify-${randomUUID()}`;
const pageSlug = `r3-b2-page-${pageSiteId}`;
const cancelSlug = `r3-b2-cancel-${cancelSiteId}`;
let nativeConnection: NativeConnection | undefined;
let clientConnection: Connection | undefined;
let worker: Worker | undefined;
let workerRun: Promise<void> | undefined;

try {
  await Promise.all([owner.$connect(), app.$connect()]);
  const intake = {
    company: { nameZh: '安可', nameEn: 'Acme' },
    industry: 'pumps',
    products: ['pumps'],
    targetMarkets: ['DE'],
    hasWebsite: false,
    businessEmail: 'sales@acme.test',
  };
  await owner.workspace.create({
    data: { id: workspaceId, name: '__r3b2_temporal_verify__' },
  });
  await owner.site.createMany({
    data: [
      { id: pageSiteId, workspaceId, name: 'New', slug: pageSlug, intake },
      {
        id: cancelSiteId,
        workspaceId,
        name: 'Cancel',
        slug: cancelSlug,
        intake,
      },
    ],
  });
  const oldSpec = buildDemoSpec({ siteName: 'Old', intake });
  const active = await owner.siteVersion.create({
    data: {
      workspaceId,
      siteId: pageSiteId,
      version: 1,
      source: 'demo_v0',
      spec: oldSpec,
      specVersion: oldSpec.specVersion,
      buildStatus: 'succeeded',
    },
  });
  await owner.site.update({
    where: { id: pageSiteId },
    data: { activeVersionId: active.id, status: 'ready' },
  });
  await owner.siteBuildRun.createMany({
    data: [
      {
        id: pageRunId,
        workspaceId,
        siteId: pageSiteId,
        kind: 'refurbish',
        status: 'queued',
        scope: {
          scope: 'page',
          targetId: 'products',
          baseVersionId: active.id,
        },
      },
      {
        id: cancelRunId,
        workspaceId,
        siteId: cancelSiteId,
        kind: 'refurbish',
        status: 'queued',
        scope: { scope: 'site' },
      },
    ],
  });

  const kb = {
    ingestText: async () => ({}) as never,
    processAsset: async () => ({ outcome: 'not_due' }) as never,
    processQueued: async (
      _ctx: unknown,
      siteId: string,
      options?: { signal?: AbortSignal },
    ) => {
      if (siteId !== cancelSiteId) return { processed: 0, failed: 0 };
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 60_000);
        options?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(options.signal?.reason ?? new Error('cancelled'));
          },
          { once: true },
        );
      });
      return { processed: 0, failed: 0 };
    },
  };
  nativeConnection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233',
  });
  worker = await Worker.create({
    connection: nativeConnection,
    namespace: process.env.TEMPORAL_NAMESPACE,
    taskQueue,
    workflowsPath: fileURLToPath(
      new URL('../src/temporal/workflows.ts', import.meta.url),
    ),
    activities: createSiteBuilderActivities({ prisma: app, kb: kb as never }),
  });
  workerRun = worker.run();
  clientConnection = await Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233',
  });
  const client = new Client({
    connection: clientConnection,
    namespace: process.env.TEMPORAL_NAMESPACE,
  });

  console.log('① real Temporal page-scope execution');
  const pageHandle = await client.workflow.start('refurbishWorkflow', {
    taskQueue,
    workflowId: `site-refurbish-${pageRunId}`,
    args: [
      {
        workspaceId,
        siteId: pageSiteId,
        buildRunId: pageRunId,
        scope: {
          scope: 'page',
          targetId: 'products',
          baseVersionId: active.id,
        },
      },
    ],
  });
  await pageHandle.result();
  const pageResult = await app.withWorkspace(workspaceId, async (tx) => {
    const run = await tx.siteBuildRun.findUniqueOrThrow({
      where: { id: pageRunId },
    });
    const site = await tx.site.findUniqueOrThrow({ where: { id: pageSiteId } });
    const version = await tx.siteVersion.findUniqueOrThrow({
      where: { id: site.activeVersionId! },
    });
    const steps = await tx.siteBuildStep.findMany({
      where: { buildRunId: pageRunId },
    });
    return { run, version, steps };
  });
  const pageSpec = pageResult.version.spec as unknown as ReturnType<
    typeof buildDemoSpec
  >;
  check(
    pageResult.run.status === 'succeeded' && pageResult.run.progress === 1,
    'real workflow reaches succeeded/1.0',
  );
  check(
    pageSpec.copyBundles.en['seo.products.title'] === 'Products — New' &&
      pageSpec.copyBundles.en['seo.home.title'] === 'Old — Pumps Supplier',
    'real workflow consumes page scope without replacing home',
  );
  check(
    pageResult.steps.length >= 6 &&
      pageResult.steps.every(
        (step) => !['queued', 'running'].includes(step.status),
      ),
    'successful workflow persists terminal step attempts',
  );

  console.log('② real Temporal cancellation terminalizes unfinished steps');
  const cancelHandle = await client.workflow.start('refurbishWorkflow', {
    taskQueue,
    workflowId: `site-refurbish-${cancelRunId}`,
    args: [
      {
        workspaceId,
        siteId: cancelSiteId,
        buildRunId: cancelRunId,
        scope: { scope: 'site' },
      },
    ],
  });
  for (let poll = 0; poll < 100; poll += 1) {
    const running = await app.withWorkspace(workspaceId, (tx) =>
      tx.siteBuildStep.findFirst({
        where: { buildRunId: cancelRunId, key: 'kb_ingest', status: 'running' },
      }),
    );
    if (running) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (poll === 99) throw new Error('cancel fixture never entered kb_ingest');
  }
  await cancelHandle.cancel();
  await cancelHandle.result().catch(() => undefined);
  const cancelled = await app.withWorkspace(workspaceId, async (tx) => ({
    run: await tx.siteBuildRun.findUniqueOrThrow({
      where: { id: cancelRunId },
    }),
    steps: await tx.siteBuildStep.findMany({
      where: { buildRunId: cancelRunId },
    }),
  }));
  check(
    cancelled.run.status === 'cancelled',
    'cancel compensation persists cancelled',
  );
  check(
    cancelled.steps.length >= 6 &&
      cancelled.steps.every(
        (step) => !['queued', 'running'].includes(step.status),
      ),
    'cancel compensation terminalizes every unfinished step attempt',
  );

  console.log('\nR3-B2 real Temporal development verification passed.');
} finally {
  worker?.shutdown();
  await workerRun?.catch(() => undefined);
  await clientConnection?.close();
  await nativeConnection?.close();
  await Promise.allSettled([
    rm(`${previewRoot()}/${pageSlug}`, { recursive: true, force: true }),
    rm(`${previewRoot()}/${cancelSlug}`, { recursive: true, force: true }),
  ]);
  await owner.site
    .deleteMany({ where: { id: { in: [pageSiteId, cancelSiteId] } } })
    .catch(() => undefined);
  await owner.workspace
    .deleteMany({ where: { id: workspaceId } })
    .catch(() => undefined);
  await Promise.allSettled([owner.$disconnect(), app.$disconnect()]);
}
