import { Module } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE } from "../execution-budget/execution-budget-authority.repository";
import {
  ExecutionBudgetPlatformWriterDatabaseModule,
  type PlatformWriterPrismaClient,
} from "../execution-budget/execution-budget-platform-writer.database";
import { PlatformScheduleConfigService } from "./platform-schedule-config.service";
import { PlatformScheduleConfigServiceTokenGuard } from "./platform-schedule-config-service-token.guard";
import { PlatformScheduleConfigInternalController } from "./platform-schedule-config-internal.controller";

@Module({
  imports: [ExecutionBudgetPlatformWriterDatabaseModule],
  controllers: [PlatformScheduleConfigInternalController],
  providers: [
    PlatformScheduleConfigServiceTokenGuard,
    {
      provide: PlatformScheduleConfigService,
      inject: [PrismaService, EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE],
      useFactory: (
        prisma: PrismaService,
        writer: PlatformWriterPrismaClient | null,
      ) =>
        new PlatformScheduleConfigService({
          reader: prisma,
          writer,
        }),
    },
  ],
  exports: [PlatformScheduleConfigService],
})
export class PlatformScheduleConfigModule {}
