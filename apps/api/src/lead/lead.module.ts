import { Module } from '@nestjs/common';
import { LeadService } from './lead.service';
import { LeadController } from './lead.controller';
import { OutreachDraftService } from './outreach-draft.service';
import { ExecutionBudgetModule } from '../execution-budget/execution-budget.module';
import { IcpModule } from '../icp/icp.module';

@Module({
  // ExecutionBudgetModule exports the workspace-grant authority the draft endpoint consumes.
  imports: [ExecutionBudgetModule, IcpModule],
  controllers: [LeadController],
  providers: [LeadService, OutreachDraftService],
})
export class LeadModule {}
