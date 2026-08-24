import { Module } from '@nestjs/common';
import { CompanyController } from './company.controller';
import { CompanyService } from './company.service';
import { ExecutionBudgetModule } from '../execution-budget/execution-budget.module';

@Module({
  imports: [ExecutionBudgetModule],
  controllers: [CompanyController],
  providers: [CompanyService],
})
export class CompanyModule {}
