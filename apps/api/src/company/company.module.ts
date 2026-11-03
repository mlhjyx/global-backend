import { Module } from '@nestjs/common';
import { searxSearch } from '../adapters/searxng';
import { CompanyController } from './company.controller';
import { CompanyService } from './company.service';
import { SEARXNG_SEARCH, WebsiteCandidatesService } from './website-candidates';
import { ExecutionBudgetModule } from '../execution-budget/execution-budget.module';

@Module({
  imports: [ExecutionBudgetModule],
  controllers: [CompanyController],
  providers: [
    CompanyService,
    WebsiteCandidatesService,
    { provide: SEARXNG_SEARCH, useValue: searxSearch },
  ],
})
export class CompanyModule {}
