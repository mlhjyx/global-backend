import 'reflect-metadata';
import 'dotenv/config';
import { NativeConnection, Worker } from '@temporalio/worker';
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
import { DiscoveryProviderRegistry } from '../discovery/provider.registry';
import { TaxonomyResolver } from '../discovery/taxonomy-resolver';
import { UNDERSTANDING_TASK_QUEUE } from './understanding.constants';

/**
 * Standalone worker process (apps/worker-ai equivalent). Builds the deps it needs
 * directly — no Nest bootstrap — so it never starts HTTP or the relay.
 */
async function main(): Promise<void> {
  const prisma = new PrismaService();
  await prisma.$connect();

  const registry = new ModelProviderRegistry();
  const gatewayProvider = buildGatewayProvider();
  if (gatewayProvider) registry.register(gatewayProvider);
  if (stubAllowed()) registry.register(new StubModelProvider());
  const gateway = new RouterModelGateway(new ModelRouter(registry), new AiTraceSink(prisma));

  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233',
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
        providers: new DiscoveryProviderRegistry({ gateway }),
        gateway,
        taxonomy: new TaxonomyResolver(prisma, gateway),
      }),
      ...createQualifyActivities({ prisma }),
      ...createAcquisitionActivities({ prisma, registry: buildSourceAdapterRegistry() }),
    },
  });

   
  console.log(`[worker] understanding worker up on task queue '${UNDERSTANDING_TASK_QUEUE}'`);
  await worker.run();
}

main().catch((err) => {
   
  console.error(err);
  process.exit(1);
});
