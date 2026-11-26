import { Module } from '@nestjs/common';
import { CompanyController } from './company.controller';
import { CompanyService } from './company.service';
import { OnboardingFactsService } from './onboarding-facts.service';
import { UnderstandingPreviewService } from './understanding-preview.service';
import { CompanyUnderstandingRecomputeService } from './company-understanding-recompute.service';
import {
  brokerBackedSearxSearch,
  SEARXNG_SEARCH,
  WebsiteCandidatesService,
} from './website-candidates';
import { ExecutionBudgetModule } from '../execution-budget/execution-budget.module';
import { SellerKnowledgeModule } from '../seller-knowledge/seller-knowledge.module';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildToolBroker,
  sourcePolicyReaderFrom,
} from '../tools/tool-broker.factory';
import { TOOL_BUDGET_STORE, type BudgetStore } from '../tools/budget-store';

@Module({
  imports: [ExecutionBudgetModule, SellerKnowledgeModule],
  controllers: [CompanyController],
  providers: [
    CompanyService,
    WebsiteCandidatesService,
    UnderstandingPreviewService,
    OnboardingFactsService,
    CompanyUnderstandingRecomputeService,
    {
      // WEB-10（v3.0 第 6 章）：元搜索出网经 ToolBroker（source_policy/预算/限流/Trace/
      // 幂等），不再有直连 searxng 的路径。ToolBroker 内部缺预算存储等资源时 fail-closed。
      provide: SEARXNG_SEARCH,
      useFactory: (prisma: PrismaService, budgetStore: BudgetStore) =>
        brokerBackedSearxSearch(
          buildToolBroker({
            sourcePolicyReader: sourcePolicyReaderFrom(prisma),
            prisma,
            budgetStore,
          }),
        ),
      inject: [PrismaService, TOOL_BUDGET_STORE],
    },
  ],
})
export class CompanyModule {}
