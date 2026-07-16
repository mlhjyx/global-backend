/**
 * verify-site-builder-m1a：M1-a 地基真机验证（§5 硬规矩，无 sandbox）。
 *
 * 五段：①intake 建档（noop demo launcher，不跑 demo）
 * ②builds.service 真库闸：建 run→同站 409→cancel→Idempotency-Key 重放命中
 * ③refurbish activity 链直调（begin→ingestPendingKb→assembleAndBuild 真 astro→finalize）
 *   → version source=build + activeVersionId 切换 + run P5/succeeded + 预览产物落盘
 * ④补偿边界 🔴：begin→compensateRefurbish → 站点仍在、状态回滚 ready、run failed、无 building 残留
 * ⑤KB 摄入 Temporal 化：真 PDF 直传→commit→queued→processQueuedKbDocs（真 MinIO+docling+BGE-M3）→ready+chunks>0
 * 尾段：brand_profile RLS A/B 隔离（app_user + is_superuser guard）。
 *
 * 依赖：cd /global/backend && docker compose -p global up -d postgres minio embeddings docling。
 * 跑：cd /global/backend/apps/api && node --import tsx scripts/verify-site-builder-m1a.mts
 */
import 'dotenv/config';
import 'reflect-metadata';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { PrismaService } from '../src/prisma/prisma.service';
import { IntakeService } from '../src/site-builder/intake.service';
import { BuildsService } from '../src/site-builder/builds.service';
import { AssetsService } from '../src/site-builder/assets.service';
import { KbService } from '../src/site-builder/kb.service';
import { StorageService } from '../src/site-builder/storage.service';
import { EmbeddingsClient } from '../src/site-builder/embeddings.client';
import { DoclingClient } from '../src/site-builder/docling.client';
import type { RefurbishLaunchInput } from '../src/site-builder/refurbish-launcher';
import { createSiteBuilderActivities, previewRoot } from '../src/temporal/site-builder.activities';

function ok(section: string, message: string): void {
  console.log(`  ✅ ${section} ${message}`);
}

/** 最小合法 PDF（真实文件，与设计前真探 H4 同源构造）。 */
function makeProbePdf(text: string): Buffer {
  const stream = Buffer.from(`BT /F1 11 Tf 50 740 Td (${text}) Tj ET`);
  const objs = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    ),
    Buffer.concat([
      Buffer.from(`<< /Length ${stream.length} >>\nstream\n`),
      stream,
      Buffer.from('\nendstream'),
    ]),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
  ];
  let buf = Buffer.from('%PDF-1.4\n');
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(buf.length);
    buf = Buffer.concat([buf, Buffer.from(`${i + 1} 0 obj\n`), o, Buffer.from('\nendobj\n')]);
  });
  const xref = buf.length;
  let tail = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) tail += `${String(off).padStart(10, '0')} 00000 n \n`;
  tail += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.concat([buf, Buffer.from(tail)]);
}

async function expectHttp(
  fn: () => Promise<unknown>,
  status: number,
  label: string,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const got = (err as { getStatus?: () => number }).getStatus?.();
    if (got === status) return;
    throw new Error(`${label}: expected HTTP ${status}, got ${got ?? String(err)}`);
  }
  throw new Error(`${label}: expected HTTP ${status}, but call succeeded`);
}

async function main(): Promise<void> {
  const prisma = new PrismaService();
  await prisma.$connect();

  // RLS 验证前置守卫（memory: rls-verify-app-user）
  const su = await prisma.$queryRaw<{ is_superuser: string }[]>`
    SELECT current_setting('is_superuser') AS is_superuser`;
  if (su[0]?.is_superuser === 'on') {
    console.error('💥 app 连接是 superuser——RLS 证明失效，中止。');
    process.exit(1);
  }

  const storage = new StorageService();
  await storage.onModuleInit();
  const kb = new KbService(prisma, new EmbeddingsClient(), new DoclingClient(), storage);
  const assets = new AssetsService(prisma, storage);

  const wsA = randomUUID();
  const wsB = randomUUID();
  const ctxA = { userId: 'verify', workspaceId: wsA, roles: [] };
  const ctxB = { userId: 'verify', workspaceId: wsB, roles: [] };
  void ctxB;

  // ── ① intake 建档（不跑 demo，直接进精装修路径）─────────────────────────
  console.log('① intake');
  const intakeService = new IntakeService(prisma, {
    launchDemoV0: async ({ buildRunId }) => ({ firstExecutionRunId: `verify-${buildRunId}` }),
    recoverDemoV0: async ({ buildRunId }) => ({ firstExecutionRunId: `verify-${buildRunId}` }),
  });
  const created = await intakeService.create(ctxA, {
    company: { nameZh: '杭州维实一号泵业', nameEn: 'Verify M1A Pump Co., Ltd.' },
    industry: 'isic-2813',
    products: ['centrifugal pump', 'screw pump'],
    targetMarkets: ['DE', 'US'],
    hasWebsite: false,
    websiteUrl: null,
    businessEmail: 'sales@verifym1a.com',
  });
  const siteId = created.siteId;
  // intake 自带的 demo_v0 run 仍 queued（verify 用 noop launcher）——同站单飞闸会正确
  // 把它算作在飞。真实时序里 demo 先完成，这里等价地置为终态。
  await prisma.withWorkspace(wsA, async (tx) => {
    await tx.siteBuildRun.updateMany({
      where: { siteId, kind: 'demo_v0' },
      data: { status: 'succeeded', finishedAt: new Date() },
    });
  });
  ok('intake', `site=${siteId}（demo run 置终态，单飞闸让位精装修）`);

  // ── ② builds.service 真库闸 ─────────────────────────────────────────────
  console.log('② builds.service（409/取消/幂等重放）');
  const launchedRefurbish: RefurbishLaunchInput[] = [];
  const builds = new BuildsService(prisma as never, {
    launchRefurbish: async (input) => {
      launchedRefurbish.push(input);
    },
    cancelRefurbish: async () => undefined,
  });
  const b1 = await builds.create(ctxA, siteId, { scope: 'site', idempotencyKey: 'verify-m1a-1' });
  if (b1.status !== 'queued' || launchedRefurbish.length !== 1) {
    throw new Error('b1 not queued/launched');
  }
  await expectHttp(() => builds.create(ctxA, siteId, { scope: 'site' }), 409, '同站在飞 409');
  await builds.cancel(ctxA, b1.buildId);
  const replay = await builds.create(ctxA, siteId, {
    scope: 'site',
    idempotencyKey: 'verify-m1a-1',
  });
  if (replay.buildId !== b1.buildId) throw new Error('idempotency replay miss');
  if (launchedRefurbish.length !== 1) throw new Error('replay must not relaunch');
  ok('builds', `run=${b1.buildId} 409/cancel/replay 全通过`);

  // ── ③ refurbish activity 链直调（真 astro build）────────────────────────
  console.log('③ refurbish 链（真 astro build）');
  const b2 = await builds.create(ctxA, siteId, { scope: 'site' });
  const activities = createSiteBuilderActivities({ prisma, kb });
  const refInput = { workspaceId: wsA, siteId, buildRunId: b2.buildId };
  const t0 = Date.now();
  await activities.beginRefurbishRun(refInput);
  const kbSummary = await activities.ingestPendingKb(refInput);
  const build = await activities.assembleAndBuild(refInput);
  const fin = await activities.finalizeRefurbish({
    ...refInput,
    kb: { ...kbSummary, degraded: false },
    build,
  });
  const buildMs = Date.now() - t0;
  const after = await prisma.withWorkspace(wsA, async (tx) => ({
    site: await tx.site.findUnique({ where: { id: siteId } }),
    version: await tx.siteVersion.findUnique({ where: { id: build.versionId } }),
    run: await tx.siteBuildRun.findUnique({ where: { id: b2.buildId } }),
  }));
  if (after.site?.activeVersionId !== build.versionId) {
    throw new Error('activeVersionId not switched');
  }
  if (after.site?.status !== 'ready') throw new Error(`site status ${after.site?.status}`);
  if (after.version?.source !== 'build' || after.version?.buildStatus !== 'succeeded') {
    throw new Error(`version wrong: ${after.version?.source}/${after.version?.buildStatus}`);
  }
  if (after.run?.status !== 'succeeded' || after.run?.phase !== 'P5_publish') {
    throw new Error(`run wrong: ${after.run?.status}/${after.run?.phase}`);
  }
  const indexHtml = await readFile(path.join(previewRoot(), fin.previewSlug, 'index.html'), 'utf8');
  if (!indexHtml.includes('Verify M1A Pump Co., Ltd.')) {
    throw new Error('company missing in preview');
  }
  ok('refurbish', `version=${after.version.version} source=build 指针已切 构建 ${buildMs}ms`);

  // ── ④ 补偿边界 🔴：绝不删站 ─────────────────────────────────────────────
  console.log('④ 补偿（不删站）');
  const b3 = await builds.create(ctxA, siteId, { scope: 'site' });
  const ref3 = { workspaceId: wsA, siteId, buildRunId: b3.buildId };
  await activities.beginRefurbishRun(ref3); // site → building
  await activities.compensateRefurbish(ref3); // 模拟 workflow catch
  const comp = await prisma.withWorkspace(wsA, async (tx) => ({
    site: await tx.site.findUnique({ where: { id: siteId } }),
    run: await tx.siteBuildRun.findUnique({ where: { id: b3.buildId } }),
    building: await tx.siteVersion.count({
      where: { buildRunId: b3.buildId, buildStatus: 'building' },
    }),
  }));
  if (!comp.site) throw new Error('🔴 site was deleted by refurbish compensation!');
  if (comp.site.status !== 'ready') throw new Error(`site status not restored: ${comp.site.status}`);
  if (comp.site.activeVersionId !== build.versionId) {
    throw new Error('activeVersionId changed by compensation');
  }
  if (comp.run?.status !== 'failed') throw new Error(`run not failed: ${comp.run?.status}`);
  if (comp.building !== 0) throw new Error('building version rows left behind');
  ok('compensate', '站点保留、状态回滚 ready、run=failed、无 building 残留');

  // ── ⑤ KB 摄入 Temporal 化（processQueuedKbDocs 真容器链）────────────────
  console.log('⑤ processQueuedKbDocs（真 MinIO+docling+BGE-M3）');
  const pdf = makeProbePdf(
    'Verify M1A brochure. Centrifugal pumps hydrostatically tested before shipment.',
  );
  const presign = await assets.presign(ctxA, siteId, {
    kind: 'doc',
    filename: 'verify-m1a.pdf',
    size: pdf.length,
    mime: 'application/pdf',
  });
  const staging = `ws/${wsA}/${siteId}/uploads/${presign.assetId}`;
  await storage.putBuffer(staging, pdf, 'application/pdf');
  const committed = await assets.commit(ctxA, presign.assetId);
  if (committed.processingStatus !== 'queued') throw new Error('doc not queued');
  const ingest = await activities.processQueuedKbDocs({ workspaceId: wsA, siteId });
  if (ingest.processed !== 1 || ingest.failed !== 0) {
    throw new Error(`ingest wrong: ${JSON.stringify(ingest)}`);
  }
  const docs = await prisma.withWorkspace(wsA, (tx) =>
    tx.kbDocument.findMany({ where: { siteId, source: 'upload' } }),
  );
  if (docs.length !== 1 || docs[0].status !== 'ready' || docs[0].chunkCount < 1) {
    throw new Error(`kb doc wrong: ${JSON.stringify(docs.map((d) => d.status))}`);
  }
  ok('kb-ingest', `doc ready, chunks=${docs[0].chunkCount}`);

  // ── ⑥ brand_profile RLS A/B ─────────────────────────────────────────────
  console.log('⑥ brand_profile RLS');
  await prisma.withWorkspace(wsA, (tx) =>
    tx.brandProfile.create({
      data: { workspaceId: wsA, siteId, version: 1, factSheet: { probe: true } },
    }),
  );
  const seenByB = await prisma.withWorkspace(wsB, (tx) => tx.brandProfile.count());
  const seenByA = await prisma.withWorkspace(wsA, (tx) =>
    tx.brandProfile.count({ where: { siteId } }),
  );
  if (seenByB !== 0) throw new Error(`🔴 RLS leak: B sees ${seenByB} brand_profile rows`);
  if (seenByA !== 1) throw new Error('A cannot see own brand_profile row');
  ok('rls', 'A 可见自己 1 行，B 零可见');

  // 清理（级联删 site 下所有派生）
  await prisma.withWorkspace(wsA, (tx) => tx.site.delete({ where: { id: siteId } }));
  await prisma.$disconnect();
  console.log('\n🎉 verify-site-builder-m1a 全段通过');
}

main().catch((err) => {
  console.error('💥 verify failed:', err);
  process.exit(1);
});
