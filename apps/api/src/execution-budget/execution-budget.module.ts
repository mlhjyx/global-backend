import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ExecutionBudgetAuthorityRepository } from './execution-budget-authority.repository';
import { ExecutionBudgetAuthorityService } from './execution-budget-authority.service';
import { ExecutionBudgetGrantVerifier } from './execution-budget-grant.verifier';
import { PlatformExecutionBudgetAuthorityIngestionService } from './platform-authority-ingestion.service';
import { ExecutionBudgetAuthorityReadinessContributors } from '../runtime/managed-dependency-readiness';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceTechnicalBudgetQuoteController } from './workspace-technical-budget-quote.controller';
import { WorkspaceTechnicalBudgetQuoteService } from './workspace-technical-budget-quote';
import { resolveWorkspaceTechnicalBudgetEnvelope } from './workspace-technical-budget-envelope';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [WorkspaceTechnicalBudgetQuoteController],
  providers: [
    {
      provide: ExecutionBudgetGrantVerifier,
      useFactory: () => new ExecutionBudgetGrantVerifier(process.env),
    },
    ExecutionBudgetAuthorityRepository,
    ExecutionBudgetAuthorityService,
    PlatformExecutionBudgetAuthorityIngestionService,
    ExecutionBudgetAuthorityReadinessContributors,
    {
      provide: WorkspaceTechnicalBudgetQuoteService,
      useFactory: () =>
        new WorkspaceTechnicalBudgetQuoteService({
          resolveEnvelope: resolveWorkspaceTechnicalBudgetEnvelope,
        }),
    },
  ],
  exports: [
    ExecutionBudgetAuthorityService,
    PlatformExecutionBudgetAuthorityIngestionService,
    WorkspaceTechnicalBudgetQuoteService,
  ],
})
export class ExecutionBudgetModule {}
