import 'reflect-metadata';
import 'dotenv/config';
import { NativeConnection, Worker } from '@temporalio/worker';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ModelProviderRegistry } from '../model-gateway/model-provider.registry';
import { ModelRouter } from '../model-gateway/model-router';
import { RouterModelGateway } from '../model-gateway/router-model-gateway';
import { StubModelProvider } from '../model-gateway/providers/stub-model.provider';
import { buildGatewayProvider, stubAllowed } from '../model-gateway/model-providers.config';
import { AiTraceSink } from '../model-gateway/ai-trace.sink';
import { createUnderstandingActivities } from './understanding.activities';
import { createDiscoveryActivities } from './discovery.activities';
import { createQualifyActivities } from './qualify.activities';
import { createAcquisitionActivities } from './acquisition.activities';
import { buildSourceAdapterRegistry } from '../acquisition/registry';
import { createIntentActivities } from './intent.activities';
import { createBacklogActivities } from './backlog.activities';
import { createExternalIntentActivities } from './external-intent.activities';
import { createDeletionActivities } from './deletion.activities';
import { createPatentsCacheActivities } from './patents-cache.activities';
import { createSanctionsRefreshActivities } from './sanctions-refresh.activities';
import { createSiteBuilderActivities } from './site-builder.activities';
import { seedSanctions } from '../sanctions/sanctions-seed';
import { SanctionsScreeningService } from '../sanctions/sanctions-screening.service';
import { KbService } from '../site-builder/kb.service';
import { EmbeddingsClient } from '../site-builder/embeddings.client';
import { DoclingClient } from '../site-builder/docling.client';
import { StorageService } from '../site-builder/storage.service';
import { ensurePlatformSchedules } from './ensure-schedules';
import { seedJurisdictionPolicy } from '../compliance/jurisdiction-policy.seed';
import { Crawl4aiPageFetcher } from '../intent/page-fetcher';
import { DiscoveryProviderRegistry } from '../discovery/provider.registry';
import { buildToolBroker, sourcePolicyReaderFrom } from '../tools/tool-broker.factory';
import { TaxonomyResolver } from '../discovery/taxonomy-resolver';
import { UNDERSTANDING_TASK_QUEUE } from './understanding.constants';

/**
 * Standalone worker process (apps/worker-ai equivalent). Builds the deps it needs
 * directly — no Nest bootstrap — so it never starts HTTP or the relay.
 */
async function main(): Promise<void> {
  const prisma = new PrismaService();
  await prisma.$connect();

  // owner 连接（DATABASE_URL）：① data_provider seed（平台配置表，app_user 无写权）；
  // ② 跨租户**只读**扫描（列 workspace / ACTIVE ICP——RLS 下 app_user 不可见）。
  // 与 OutboxRelayService 同一「受信系统扫描器」先例；租户数据读写仍走 withWorkspace。
  const ownerDb = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  await ownerDb.$connect();

  // seed 双保险：此前只在 API relay 启动时 seed 且失败静默——环境重置后只跑 worker 时，
  // 4 个 signal provider 对路由不可见（信号/富集层运行时 no-op）。失败必须大声。
  const providerRegistrySeed = new DiscoveryProviderRegistry();
  try {
    await providerRegistrySeed.seed(ownerDb);
    console.log('[worker] data_provider seed ok');
  } catch (err) {
    console.error(`[worker] data_provider seed FAILED — providers may be invisible to routing (no-op pipeline): ${String(err)}`);
  }

  // 收口⑥：jurisdiction_policy seed（平台规则表，owner 写）。worker 的删除编排/合规判定需之；
  // 失败大声——规则空则 DataRights 对 red 数据 fail-closed。
  try {
    const n = await seedJurisdictionPolicy(ownerDb);
    console.log(`[worker] jurisdiction_policy seed ok (${n} rules)`);
  } catch (err) {
    console.error(`[worker] jurisdiction_policy seed FAILED — DataRights fail-closed for red data: ${String(err)}`);
  }

  // 制裁名单源 + source_policy seed（第五门，owner 写平台表；全 DISABLED，真测绿后 ops 翻 ENABLED）。
  try {
    await seedSanctions(ownerDb);
    console.log('[worker] sanctions source/policy seed ok (DISABLED until ops enables)');
  } catch (err) {
    console.error(`[worker] sanctions seed FAILED — refresh/screening may be misconfigured: ${String(err)}`);
  }

  // Schedule 自愈：dev Temporal（start-dev/SQLite）重置即丢 Schedule，靠人手跑脚本必然遗忘。
  try {
    await ensurePlatformSchedules();
  } catch (err) {
    console.error(`[worker] ensure schedules FAILED（定时 sweep 可能停摆，可手跑 scripts/ensure-*-schedule.mts）: ${String(err)}`);
  }

  const registry = new ModelProviderRegistry();
  const gatewayProvider = buildGatewayProvider();
  if (gatewayProvider) registry.register(gatewayProvider);
  if (stubAllowed()) registry.register(new StubModelProvider());
  const gateway = new RouterModelGateway(new ModelRouter(registry), new AiTraceSink(prisma));

  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233',
  });

  // 收口②：**唯一执行闸门**——全部原始出网（搜索/抓取/结构化 API/SMTP）经同一个 ToolBroker
  // （allowedTools 白名单 + source_policy fail-closed + 预算 reserve-settle + 限流 + Trace）。
  const sourcePolicyReader = sourcePolicyReaderFrom(prisma);
  const broker = buildToolBroker({ sourcePolicyReader });
  const taxonomy = new TaxonomyResolver(prisma, gateway); // discovery + external-intent sweep 共享一实例
  // 第五门制裁筛查引擎（worker 侧）：qualify 活动 screen 公司名 + 刷新活动重建索引。手工构造（非 Nest DI）；
  // 平台表无 RLS、app_user 只读 → prisma 读即可。DISABLED（Phase 1 默认）→ 空索引 → not_screened，no-op。
  const sanctionsScreening = new SanctionsScreeningService(prisma);
  await sanctionsScreening.rebuildIndex().catch((err) =>
    console.error(`[worker] sanctions index build FAILED (fail-open, gate=not_screened): ${String(err)}`),
  );
  // prisma（app_user）给专利缓存读/enqueue 闭包（平台表无 RLS）——PATENT_SOURCE_MODE=cache 时零 BQ 字节读缓存。
  const providers = new DiscoveryProviderRegistry({ gateway, broker, prisma });

  const worker = await Worker.create({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: UNDERSTANDING_TASK_QUEUE,
    workflowsPath: require.resolve('./workflows'),
    activities: {
      ...createUnderstandingActivities({ prisma, gateway, broker }),
      ...createDiscoveryActivities({
        prisma,
        providers,
        gateway,
        taxonomy,
        broker,
      }),
      ...createQualifyActivities({ prisma, sanctionsScreening }),
      ...createAcquisitionActivities({ prisma, registry: buildSourceAdapterRegistry(broker) }),
      ...createIntentActivities({ prisma, fetcher: new Crawl4aiPageFetcher(broker), ownerDb, broker }),
      ...createBacklogActivities({ prisma, providers, gateway, ownerDb, broker }),
      // 外部源 intent sweep（TED 招标 + openFDA 510k 清关 → ACTIVE ICP 投影，externalIntentSweepWorkflow 调度）
      ...createExternalIntentActivities({ prisma, taxonomy, ownerDb, broker }),
      // 收口⑥ PR-B 删除编排（GDPR Art.17，on-demand：DeletionService 按 deletion_request 触发 deletionWorkflow）
      ...createDeletionActivities({ prisma }),
      // 专利发明人缓存刷新（scale-safe #89，第 5 个周期 Schedule；owner 连接写平台表 patent_*、读 source_policy 门）
      ...createPatentsCacheActivities({ ownerDb }),
      // 制裁名单每日刷新（第五门）：owner 写平台表、下载经 broker、刷新后重建 worker 内 screener 索引
      ...createSanctionsRefreshActivities({ ownerDb, broker, sanctionsScreening }),
      // 独立站建设（demo v0 + 精装修 refurbish；broker=brandProfile web 研究的唯一出网闸门）
      ...createSiteBuilderActivities({
        prisma,
        gateway,
        broker,
        kb: new KbService(prisma, new EmbeddingsClient(), new DoclingClient(), new StorageService()),
      }),
    },
  });

   
  console.log(`[worker] understanding worker up on task queue '${UNDERSTANDING_TASK_QUEUE}'`);
  await worker.run();
}

main().catch((err) => {
   
  console.error(err);
  process.exit(1);
});
