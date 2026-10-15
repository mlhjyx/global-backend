import { Module } from '@nestjs/common';
import { ReportController } from './report.controller';
import { WeeklyReportService } from './weekly-report.service';

/**
 * Lead delivery reports (BI-22). PrismaService, DataRightsService and SanctionsScreeningService
 * come from their global modules.
 */
@Module({
  controllers: [ReportController],
  providers: [WeeklyReportService],
})
export class ReportModule {}
