import { Module } from "@nestjs/common";
import { MeasurementController } from "./measurement.controller";
import { MeasurementService } from "./measurement.service";

/** ch01 PR-04：度量只读 API（PrismaService 来自全局 PrismaModule）。 */
@Module({
  controllers: [MeasurementController],
  providers: [MeasurementService],
})
export class MeasurementModule {}
