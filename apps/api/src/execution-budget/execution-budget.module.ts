import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ExecutionBudgetAuthorityRepository } from './execution-budget-authority.repository';
import { ExecutionBudgetAuthorityService } from './execution-budget-authority.service';
import { ExecutionBudgetGrantVerifier } from './execution-budget-grant.verifier';
import { PlatformExecutionBudgetAuthorityIngestionService } from './platform-authority-ingestion.service';
import { ExecutionBudgetAuthorityReadinessContributors } from '../runtime/managed-dependency-readiness';

@Module({
  imports: [PrismaModule],
  providers: [
    {
      provide: ExecutionBudgetGrantVerifier,
      useFactory: () => new ExecutionBudgetGrantVerifier(process.env),
    },
    ExecutionBudgetAuthorityRepository,
    ExecutionBudgetAuthorityService,
    PlatformExecutionBudgetAuthorityIngestionService,
    ExecutionBudgetAuthorityReadinessContributors,
  ],
  exports: [
    ExecutionBudgetAuthorityService,
    PlatformExecutionBudgetAuthorityIngestionService,
  ],
})
export class ExecutionBudgetModule {}
