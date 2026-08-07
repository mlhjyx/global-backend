import { Module } from "@nestjs/common";
import { LeadQualityLabelsController } from "./lead-quality-label.controller";
import {
  LeadQualityLabelLearningConsumer,
  LeadQualityLabelRepository,
} from "./lead-quality-label.repository";
import { LeadQualityLabelsService } from "./lead-quality-label.service";

@Module({
  controllers: [LeadQualityLabelsController],
  providers: [
    LeadQualityLabelRepository,
    LeadQualityLabelLearningConsumer,
    LeadQualityLabelsService,
  ],
  exports: [LeadQualityLabelLearningConsumer],
})
export class LeadQualityLabelModule {}
