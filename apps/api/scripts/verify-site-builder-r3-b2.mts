/**
 * R3-B2 live verifier for an isolated Ubuntu development database.
 * Proves empty migration, app_user/FORCE RLS, monotonic progress/attempt fencing,
 * terminal step closure and deterministic page/section/pages scope merging.
 */
import 'dotenv/config';
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  recordBuildProgress,
  terminalizeBuildProgress,
} from '../src/site-builder/build-progress';
import { applyBuildScope } from '../src/site-builder/build-scope';
import { buildDemoSpec } from '../src/site-builder/demo-spec';

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
    const raw = process.env[name];
    if (!raw) throw new Error(`${name} is required`);
    const url = new URL(raw);
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) {
      throw new Error(`${name} must target loopback`);
    }
    if (!/^\/global_r3b2_verify(?:_|$)/.test(url.pathname)) {
      throw new Error(
        `${name} must target an isolated global_r3b2_verify database`,
      );
    }
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
const otherWorkspaceId = randomUUID();
const siteId = randomUUID();
const runId = randomUUID();

try {
  await Promise.all([owner.$connect(), app.$connect()]);
  const [role] = await app.$queryRaw<
    Array<{ currentUser: string; isSuper: boolean; bypassRls: boolean }>
  >`SELECT current_user AS "currentUser", rolsuper AS "isSuper", rolbypassrls AS "bypassRls"
    FROM pg_roles WHERE rolname = current_user`;
  check(
    role?.currentUser === 'app_user' && !role.isSuper && !role.bypassRls,
    'application connection is app_user without superuser/BYPASSRLS',
  );

  await owner.workspace.createMany({
    data: [
      { id: workspaceId, name: '__r3b2_verify__' },
      { id: otherWorkspaceId, name: '__r3b2_verify_other__' },
    ],
  });
  await owner.site.create({
    data: {
      id: siteId,
      workspaceId,
      name: 'R3-B2 verifier',
      slug: `r3-b2-${siteId}`,
      intake: {},
    },
  });
  await owner.siteBuildRun.create({
    data: {
      id: runId,
      workspaceId,
      siteId,
      kind: 'refurbish',
      status: 'running',
      phase: 'P2_assets',
      progress: 0.5,
      startedAt: new Date(),
    },
  });

  console.log('① monotonic progress and late-attempt fencing');
  await recordBuildProgress(
    app,
    { workspaceId, buildRunId: runId },
    {
      key: 'image_pipeline',
      itemKey: 'batch-a',
      attempt: 2,
      status: 'done',
      phase: 'P2_assets',
      progress: 0.6,
    },
  );
  await recordBuildProgress(
    app,
    { workspaceId, buildRunId: runId },
    {
      key: 'image_pipeline',
      itemKey: 'batch-a',
      attempt: 1,
      status: 'failed',
      phase: 'P1_understanding',
      progress: 0.2,
    },
  );
  const [run, steps] = await app.withWorkspace(workspaceId, (tx) =>
    Promise.all([
      tx.siteBuildRun.findUniqueOrThrow({ where: { id: runId } }),
      tx.siteBuildStep.findMany({ where: { buildRunId: runId } }),
    ]),
  );
  check(
    run.phase === 'P2_assets' && run.progress === 0.6,
    'older phase/progress cannot move the BuildRun backwards',
  );
  check(
    steps.length === 1 && steps[0].attempt === 2 && steps[0].status === 'done',
    'late attempt 1 cannot overwrite durable attempt 2',
  );
  await recordBuildProgress(
    app,
    { workspaceId, buildRunId: runId },
    {
      key: 'brand_profile',
      status: 'running',
      phase: 'P2_assets',
      progress: 0.6,
    },
  );
  await recordBuildProgress(
    app,
    { workspaceId, buildRunId: runId },
    {
      key: 'brand_profile',
      status: 'done',
      phase: 'P2_assets',
      progress: 0.65,
    },
  );
  await recordBuildProgress(
    app,
    { workspaceId, buildRunId: runId },
    {
      key: 'brand_profile',
      status: 'failed',
      phase: 'P2_assets',
      progress: 0.7,
    },
  );
  const logical = await app.withWorkspace(workspaceId, (tx) =>
    tx.siteBuildStep.findMany({
      where: { buildRunId: runId, key: 'brand_profile' },
    }),
  );
  check(
    logical.length === 1 &&
      logical[0].attempt === 1 &&
      logical[0].status === 'done',
    'running/done share one logical attempt and terminal status is immutable',
  );

  console.log('② FORCE RLS and terminal closure');
  const invisible = await app.withWorkspace(otherWorkspaceId, (tx) =>
    tx.siteBuildStep.count({ where: { buildRunId: runId } }),
  );
  check(invisible === 0, 'another workspace cannot observe the step record');
  await app.withWorkspace(workspaceId, async (tx) => {
    const readModel = await terminalizeBuildProgress(tx, {
      workspaceId,
      buildRunId: runId,
      phase: 'P2_assets',
      progress: 0.6,
    });
    await tx.siteBuildRun.update({
      where: { id: runId },
      data: { status: 'cancelled', steps: readModel, finishedAt: new Date() },
    });
  });
  const terminal = await app.withWorkspace(workspaceId, (tx) =>
    tx.siteBuildStep.findMany({ where: { buildRunId: runId } }),
  );
  check(
    terminal.length >= 6 &&
      terminal.every((step) => !['queued', 'running'].includes(step.status)),
    'terminal BuildRun leaves no queued/running step attempts',
  );

  console.log('③ deterministic partial SiteSpec consumption');
  const intake = {
    company: { nameZh: '安可', nameEn: 'Acme' },
    industry: 'pumps',
    products: ['pumps'],
    targetMarkets: ['DE'],
    hasWebsite: false,
    businessEmail: 'sales@acme.test',
  };
  const active = buildDemoSpec({ siteName: 'Old', intake });
  const candidate = buildDemoSpec({ siteName: 'New', intake });
  const page = applyBuildScope(active, candidate, {
    scope: 'page',
    targetId: 'products',
  });
  const section = applyBuildScope(active, candidate, {
    scope: 'section',
    targetId: 'AboutBlock-demo-1',
  });
  const pages = applyBuildScope(active, candidate, {
    scope: 'site',
    options: { pages: ['home', 'contact'] },
  });
  check(
    page.copyBundles.en['seo.products.title'] === 'Products — New' &&
      page.copyBundles.en['seo.home.title'] === 'Old — Pumps Supplier',
    'page scope replaces only target page copy',
  );
  check(
    section.pages[0].puck.content.length ===
      active.pages[0].puck.content.length,
    'section scope replaces one block without changing sibling count',
  );
  check(
    pages.copyBundles.en['seo.contact.title'] === 'Contact — New' &&
      pages.copyBundles.en['seo.products.title'] === 'Products — Old',
    'options.pages preserves unselected pages',
  );

  console.log('\nR3-B2 isolated development verification passed.');
} finally {
  await owner.site.deleteMany({ where: { id: siteId } }).catch(() => undefined);
  await owner.workspace
    .deleteMany({
      where: { id: { in: [workspaceId, otherWorkspaceId] } },
    })
    .catch(() => undefined);
  await Promise.allSettled([owner.$disconnect(), app.$disconnect()]);
}
