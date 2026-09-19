import { Module } from "@nestjs/common";
import { QualificationFeedbackController } from "./qualification-feedback.controller";
import { QualificationFeedbackService } from "./qualification-feedback.service";

@Module({
  controllers: [QualificationFeedbackController],
  providers: [QualificationFeedbackService],
})
export class QualificationFeedbackModule {}
