import { Module } from '@nestjs/common';
import { DiscoveryService } from './discovery.service';
import { ContactEnrichmentService, CONTACT_ENRICHMENT_SAFETY_EXECUTOR } from './enrich-contacts.service';
import { DiscoveryController } from './discovery.controller';
import { StreamingProgressController } from './streaming/streaming-progress.controller';
import { RunResultViewController } from './run-result-view.controller';
import { JudgmentReviewController } from './judgment/judgment-review.controller';
import { DiscoveryProviderRegistry } from './provider.registry';
import { ModelGateway } from '../model-gateway/model-gateway';
import { PrismaService } from '../prisma/prisma.service';
import { buildToolBroker, sourcePolicyReaderFrom } from '../tools/tool-broker.factory';
import { LangfuseRuntimeTelemetryService } from '../model-runtime';
import { TOOL_BUDGET_STORE, type BudgetStore } from '../tools/budget-store';
import { createWorkspaceBudgetStore } from '../execution-budget/legacy-execution-budget-mode';
import { TOOL_BROKER } from '../tools/tool-broker.tokens';
import type { ExecutionBroker } from '../tools/tool-contract';
import { ExecutionBudgetModule } from '../execution-budget/execution-budget.module';
import { ExecutionBudgetAuthorityService } from '../execution-budget/execution-budget-authority.service';
import { createFailClosedSafetyExecutor, createManagedContactEnrichmentSafety } from '../enrichment/safety/contact-enrichment-safety.composition';
import { ContactEnrichmentResultsController, CONTACT_ENRICHMENT_RESULTS_PORT } from '../enrichment/safety/contact-enrichment-results.controller';
import { ContactEnrichmentQualityFactsController } from '../enrichment/safety/contact-enrichment-quality-facts.controller';

const CONTACT_ENRICHMENT_SAFETY_COMPOSITION = Symbol('CONTACT_ENRICHMENT_SAFETY_COMPOSITION');

@Module({
  imports: [ExecutionBudgetModule],
  controllers: [DiscoveryController, StreamingProgressController, JudgmentReviewController, RunResultViewController, ContactEnrichmentResultsController, ContactEnrichmentQualityFactsController],
  providers: [
    {
      provide: TOOL_BUDGET_STORE,
      useFactory: (prisma: PrismaService) => createWorkspaceBudgetStore(prisma),
      inject: [PrismaService],
    },
    {
      provide: CONTACT_ENRICHMENT_SAFETY_COMPOSITION,
      useFactory: async (prisma: PrismaService, budgetStore: BudgetStore, authority: ExecutionBudgetAuthorityService) =>
        createManagedContactEnrichmentSafety({
          prisma,
          env: process.env,
          budgetStore,
          authority,
          grantConsumer: {
            consumeVerifiedWorkspaceGrantInTransaction: (verified, tx) =>
              authority.consumeVerifiedWorkspaceGrantInTransaction(verified, tx),
          },
          buildBroker: (ports) =>
            buildToolBroker({
              sourcePolicyReader: sourcePolicyReaderFrom(prisma),
              prisma,
              budgetStore,
              ...(ports ? { contactEnrichment: ports } : {}),
            }),
        }),
      inject: [PrismaService, TOOL_BUDGET_STORE, ExecutionBudgetAuthorityService],
    },
    {
      provide: TOOL_BROKER,
      useFactory: (composition: Awaited<ReturnType<typeof createManagedContactEnrichmentSafety>>) => composition.broker,
      inject: [CONTACT_ENRICHMENT_SAFETY_COMPOSITION],
    },
    DiscoveryService,
    ContactEnrichmentService,
    {
      provide: CONTACT_ENRICHMENT_SAFETY_EXECUTOR,
      useFactory: (composition: Awaited<ReturnType<typeof createManagedContactEnrichmentSafety>>) =>
        composition.service ?? createFailClosedSafetyExecutor(composition.unavailableReason ?? 'GOVERNANCE_PENDING'),
      inject: [CONTACT_ENRICHMENT_SAFETY_COMPOSITION],
    },
    {
      provide: CONTACT_ENRICHMENT_RESULTS_PORT,
      useExisting: CONTACT_ENRICHMENT_SAFETY_EXECUTOR,
    },
    {
      provide: DiscoveryProviderRegistry,
      // API 侧的联系人发现/邮箱验证走真实 public_web —— 注入全局 ModelGateway。
      useFactory: (
        gateway: ModelGateway,
        prisma: PrismaService,
        runtimeTelemetry: LangfuseRuntimeTelemetryService,
        broker: ExecutionBroker,
      ) =>
        new DiscoveryProviderRegistry({
          gateway,
          broker,
          prisma, // 专利缓存读/enqueue 闭包（app_user，平台表无 RLS）
          runtimeTelemetry,
        }),
      inject: [ModelGateway, PrismaService, LangfuseRuntimeTelemetryService, TOOL_BROKER],
    },
  ],
  exports: [DiscoveryProviderRegistry],
})
export class DiscoveryModule {}
