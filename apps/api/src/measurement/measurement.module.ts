import { Module } from "@nestjs/common";
import { MeasurementController } from "./measurement.controller";
import { MeasurementService } from "./measurement.service";
import { SourceYieldService } from "./source-yield";
import { BillingReconciliationService } from "./billing-reconciliation";

/**
 * ch01 PR-04：度量只读 API（PrismaService 来自全局 PrismaModule）。
 * 获客 vNext W3 追加：源边际产出（source-yield）与三方对账（billing-reconciliation）。
 */
@Module({
  controllers: [MeasurementController],
  providers: [MeasurementService, SourceYieldService, BillingReconciliationService],
})
export class MeasurementModule {}
