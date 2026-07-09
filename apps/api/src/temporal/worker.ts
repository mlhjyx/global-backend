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
import { ensurePlatformSchedules } from './ensure-schedules';
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

  // 邮箱验证 SMTP 出网经 ToolBroker 闸门；source_policy 走平台级治理表（无 RLS，直读）。
  const sourcePolicyReader = sourcePolicyReaderFrom(prisma);
  const taxonomy = new TaxonomyResolver(prisma, gateway); // discovery + external-intent sweep 共享一实例
  const providers = new DiscoveryProviderRegistry({
    gateway,
    broker: buildToolBroker({ sourcePolicyReader }),
    sourcePolicyReader, // §8.8：TED adapter 直连前查 source_policy 用途门（含个人数据源必走）
  });

  const worker = await Worker.create({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: UNDERSTANDING_TASK_QUEUE,
    workflowsPath: require.resolve('./workflows'),
    activities: {
      ...createUnderstandingActivities({ prisma, gateway }),
      ...createDiscoveryActivities({
        prisma,
        providers,
        gateway,
        taxonomy,
      }),
      ...createQualifyActivities({ prisma }),
      ...createAcquisitionActivities({ prisma, registry: buildSourceAdapterRegistry() }),
      ...createIntentActivities({ prisma, fetcher: new Crawl4aiPageFetcher(), ownerDb }),
      ...createBacklogActivities({ prisma, providers, gateway, ownerDb }),
      // 外部源 intent sweep（TED 招标 + openFDA 510k 清关 → ACTIVE ICP 投影，externalIntentSweepWorkflow 调度）
      ...createExternalIntentActivities({ prisma, taxonomy, ownerDb, sourcePolicyReader }),
    },
  });

   
  console.log(`[worker] understanding worker up on task queue '${UNDERSTANDING_TASK_QUEUE}'`);
  await worker.run();
}

main().catch((err) => {
   
  console.error(err);
  process.exit(1);
});
