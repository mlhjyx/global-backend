import { Module } from "@nestjs/common";
import { AcquisitionAuthorizationIntegrationPendingGuard } from "../auth/acquisition-authorization-integration-pending.guard";
import { LeadQualityLabelsController } from "./lead-quality-label.controller";
import {
  LeadQualityLabelLearningConsumer,
  LeadQualityLabelRepository,
} from "./lead-quality-label.repository";
import { LeadQualityLabelsService } from "./lead-quality-label.service";

@Module({
  controllers: [LeadQualityLabelsController],
  providers: [
    AcquisitionAuthorizationIntegrationPendingGuard,
    LeadQualityLabelRepository,
    LeadQualityLabelLearningConsumer,
    LeadQualityLabelsService,
  ],
  exports: [LeadQualityLabelLearningConsumer],
})
export class LeadQualityLabelModule {}
