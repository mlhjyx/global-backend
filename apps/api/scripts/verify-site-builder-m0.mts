/**
 * verify-site-builder-m0：独立站建设 M0 真实端到端（§5 硬规矩，无 sandbox）。
 *
 * 五段：①intake→建档+run ②demo v0 activity 直调（真 astro build→预览产物）
 * ③预览 HTTP 可访问（脚本内最小 ServeStatic 应用，同 app.module 配置形状）
 * ④素材直传→commit 安全闸→KB 摄入（真 MinIO + 真 BGE-M3 1024 维）→语义检索命中
 * ⑤RLS 隔离证明（app_user + is_superuser guard；B 租户看不见 A 的一切）。
 *
 * 依赖：cd /global/backend && docker compose -p global up -d postgres minio embeddings（docling 可选，§4 软检查）。
 * 跑：cd /global/backend/apps/api && node --import tsx scripts/verify-site-builder-m0.mts
 */
import 'dotenv/config';
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import { ServeStaticModule } from '@nestjs/serve-static';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { PrismaService } from '../src/prisma/prisma.service';
import { IntakeService } from '../src/site-builder/intake.service';
import { SitesService } from '../src/site-builder/sites.service';
import { AssetsService } from '../src/site-builder/assets.service';
import { KbService } from '../src/site-builder/kb.service';
import { StorageService } from '../src/site-builder/storage.service';
import { EmbeddingsClient } from '../src/site-builder/embeddings.client';
import { DoclingClient } from '../src/site-builder/docling.client';
import { previewUrlFor } from '../src/site-builder/preview-url';
import type { DemoV0LaunchInput } from '../src/site-builder/demo-launcher';
import { createSiteBuilderActivities, previewRoot } from '../src/temporal/site-builder.activities';

const PREVIEW_TEST_PORT = 3999;

function ok(section: string, message: string): void {
  console.log(`  ✅ ${section} ${message}`);
}

async function main(): Promise<void> {
  const prisma = new PrismaService();
  const owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  await Promise.all([prisma.$connect(), owner.$connect()]);

  // RLS 验证前置守卫（memory: rls-verify-app-user）
  const su = await prisma.$queryRaw<{ is_superuser: string }[]>`
    SELECT current_setting('is_superuser') AS is_superuser`;
  if (su[0]?.is_superuser === 'on') {
    console.error('💥 app 连接是 superuser（APP_DATABASE_URL 应指向 app_user）——RLS 证明失效，中止。');
    process.exit(1);
  }

  const storage = new StorageService();
  await storage.onModuleInit(); // 幂等建桶
  const embeddings = new EmbeddingsClient();
  const docling = new DoclingClient();
  const kb = new KbService(prisma, embeddings, docling, storage);
  const assets = new AssetsService(prisma, storage);
  const sites = new SitesService(prisma);

  const launched: DemoV0LaunchInput[] = [];
  const intakeService = new IntakeService(prisma, {
    launchDemoV0: async (input) => {
      launched.push(input);
      return { firstExecutionRunId: `verify-${input.buildRunId}` };
    },
    recoverDemoV0: async (input) => ({ firstExecutionRunId: `verify-${input.buildRunId}` }),
  });

  const wsA = randomUUID();
  const wsB = randomUUID();
  const ctxA = { userId: 'verify', workspaceId: wsA, roles: [] };
  const ctxB = { userId: 'verify', workspaceId: wsB, roles: [] };
  // R2-A1 cleanup intent 对 workspace 有真实 FK；verifier 不再依赖历史的“裸 UUID 租户”。
  await owner.workspace.createMany({
    data: [
      { id: wsA, name: 'site-builder-m0-verify' },
      { id: wsB, name: 'site-builder-m0-verify-other' },
    ],
  });

  // ── ① intake：建档 + demo run 排队 ──────────────────────────────────────
  console.log('① intake');
  const intake = {
    company: { nameZh: '杭州维实泵业有限公司', nameEn: 'Verify Pump Co., Ltd.' },
    industry: 'isic-2813',
    products: ['centrifugal pump', 'screw pump'],
    targetMarkets: ['DE', 'US'],
    hasWebsite: false,
    websiteUrl: null,
    businessEmail: 'sales@verifypump.com',
  };
  const created = await intakeService.create(ctxA, intake);
  if (created.status !== 'generating_demo' || created.buildId !== launched[0]?.buildRunId) {
    throw new Error(`unexpected intake result ${JSON.stringify(created)}`);
  }
  if (launched.length !== 1) throw new Error('demo launcher not invoked exactly once');
  ok('intake', `site=${created.siteId} run=${created.buildId} queued`);

  // ── ② demo v0：activity 直调（真 astro build；Temporal 接线由 worker 注册）──
  console.log('② demo v0（真 astro build）');
  const activities = createSiteBuilderActivities({ prisma, kb });
  const t0 = Date.now();
  const { previewSlug } = await activities.generateDemoV0(launched[0]);
  const buildMs = Date.now() - t0;
  const siteRow = await sites.get(ctxA, created.siteId);
  if (siteRow.status !== 'ready' || !siteRow.activeVersionId) {
    throw new Error(`site not ready after demo v0: ${siteRow.status}`);
  }
  const indexHtml = await readFile(path.join(previewRoot(), previewSlug, 'index.html'), 'utf8');
  if (!indexHtml.includes('Verify Pump Co., Ltd.')) throw new Error('company name missing in demo');
  await readFile(path.join(previewRoot(), previewSlug, 'products', 'index.html'), 'utf8');
  const url = previewUrlFor(siteRow);
  if (!url) throw new Error('previewUrl null for ready site');
  ok('demo', `built in ${buildMs}ms → ${url}`);

  // ── ③ 预览 HTTP 可访问（最小 ServeStatic 应用 = app.module 同款配置）────
  console.log('③ 预览 HTTP');
  @Module({
    imports: [
      ServeStaticModule.forRoot({
        rootPath: previewRoot(),
        serveRoot: '/preview',
        serveStaticOptions: { index: ['index.html'], fallthrough: true },
      }),
    ],
  })
  class PreviewOnlyModule {}
  const app = await NestFactory.create(PreviewOnlyModule, { logger: false });
  await app.listen(PREVIEW_TEST_PORT);
  const res = await fetch(`http://localhost:${PREVIEW_TEST_PORT}/preview/${previewSlug}/`);
  const body = await res.text();
  if (res.status !== 200 || !body.includes('Verify Pump Co., Ltd.')) {
    throw new Error(`preview HTTP failed: ${res.status}`);
  }
  // 子路径回归守卫：所有根绝对 href/src 必须带 /preview/{slug} base，且逐个可 200
  const assetPaths = [...body.matchAll(/(?:href|src)="(\/[^"]+)"/g)].map((m) => m[1]);
  for (const p of assetPaths) {
    if (!p.startsWith(`/preview/${previewSlug}`)) {
      throw new Error(`root-absolute link escapes preview base (would 404): ${p}`);
    }
    const r = await fetch(`http://localhost:${PREVIEW_TEST_PORT}${p}`);
    if (r.status !== 200) throw new Error(`preview asset ${r.status}: ${p}`);
  }
  await app.close();
  ok('preview', `GET /preview/${previewSlug}/ → 200；${assetPaths.length} 个站内资产/链接全部 200`);

  // ── ④ 素材直传 → commit 安全闸 → KB → 语义检索 ─────────────────────────
  console.log('④ 素材 + KB（真 MinIO + 真 BGE-M3）');
  const profileText = [
    '# Verify Pump company profile',
    '## Quality',
    'Every centrifugal pump passes hydrostatic testing before delivery.',
    '## Export',
    'Main export markets are Germany and the United States, shipped from Shanghai port.',
  ].join('\n\n');
  const fileBuffer = Buffer.from(profileText, 'utf8');
  const presign = await assets.presign(ctxA, created.siteId, {
    kind: 'doc',
    filename: 'company-profile.md',
    size: fileBuffer.length,
    mime: 'text/markdown',
  });
  const putRes = await fetch(presign.uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': 'text/markdown' },
    body: fileBuffer,
  });
  if (!putRes.ok) throw new Error(`presigned PUT failed: ${putRes.status}`);
  const committed = await assets.commit(ctxA, presign.assetId);
  if (committed.processingStatus !== 'queued') {
    throw new Error(`doc not queued for KB: ${committed.processingStatus}`);
  }
  const summary = await kb.processQueued(ctxA, created.siteId);
  if (summary.processed !== 1 || summary.failed !== 0) {
    throw new Error(`kb processQueued unexpected: ${JSON.stringify(summary)}`);
  }
  const status = await kb.status(ctxA, created.siteId);
  if (status.documents < 2 || status.chunks < 3) {
    // intake 资料 + 上传文档
    throw new Error(`kb status too small: ${JSON.stringify(status)}`);
  }
  const hits = await kb.search(ctxA, created.siteId, 'pump quality testing before delivery', 3);
  if (hits.length === 0 || !hits[0].text.toLowerCase().includes('hydrostatic')) {
    throw new Error(`semantic search missed: ${JSON.stringify(hits.slice(0, 1))}`);
  }
  ok('kb', `docs=${status.documents} chunks=${status.chunks} top-hit score=${hits[0].score.toFixed(3)}`);

  // 魔数闸负例：声明 jpeg 实为文本 → rejected
  const evil = Buffer.from('not a jpeg at all');
  const evilPresign = await assets.presign(ctxA, created.siteId, {
    kind: 'product_image',
    filename: 'evil.jpg',
    size: evil.length,
    mime: 'image/jpeg',
  });
  await fetch(evilPresign.uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': 'image/jpeg' },
    body: evil,
  });
  let rejected = false;
  try {
    await assets.commit(ctxA, evilPresign.assetId);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error('magic-number gate failed to reject fake jpeg');
  ok('gate', '魔数闸拒绝伪装 jpeg（rejected）');

  // ── ④b Docling 软检查（容器可选；不可用则 SKIP 不算失败）────────────────
  try {
    const health = await fetch(`${process.env.DOCLING_URL ?? 'http://localhost:5001'}/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (health.ok) {
      const converted = await docling.convertToMarkdown(
        'hello.md',
        Buffer.from('# Hello\n\nDocling roundtrip test.', 'utf8'),
      );
      ok('docling', `convert ok（${converted.markdown.length} chars）`);
    } else {
      console.log('  ⏭️ docling 健康检查非 200，SKIP（M0 KB 主路径 txt/md 已证）');
    }
  } catch {
    console.log('  ⏭️ docling 未就绪，SKIP（容器仍在拉取/首启；M1 verify 必测 PDF）');
  }

  // ── ⑤ RLS 隔离：B 租户看不见 A 的站点/素材/KB ──────────────────────────
  console.log('⑤ RLS 隔离');
  const bSites = await sites.list(ctxB);
  if (bSites.length !== 0) throw new Error(`tenant B sees ${bSites.length} sites of others`);
  let bBlocked = false;
  try {
    await sites.get(ctxB, created.siteId);
  } catch {
    bBlocked = true;
  }
  if (!bBlocked) throw new Error('tenant B can read tenant A site');
  const bHits = await kb.search(ctxB, created.siteId, 'pump quality', 3);
  if (bHits.length !== 0) throw new Error('tenant B can search tenant A kb');
  const bStatus = await kb.status(ctxB, created.siteId);
  if (bStatus.documents !== 0) throw new Error('tenant B sees tenant A kb docs');
  ok('rls', 'B 租户对 A 的 site/kb/检索全部不可见');

  console.log('\n🎉 M0 端到端全绿：intake → demo v0(真构建) → 预览 HTTP → 素材/KB(真向量) → RLS。');
  console.log(`   预览产物：${path.join(previewRoot(), previewSlug)}`);
  await owner.site.deleteMany({ where: { id: created.siteId } });
  await owner.workspace.deleteMany({ where: { id: { in: [wsA, wsB] } } });
  await Promise.all([prisma.$disconnect(), owner.$disconnect()]);
}

main().catch((err) => {
  console.error('💥 verify failed:', err);
  process.exit(1);
});
