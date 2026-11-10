import { Module } from "@nestjs/common";
import { EvaluationController } from "./evaluation.controller";
import { EvaluationService } from "./evaluation.service";

/** 获客 vNext W3：评估学与产出会计（PrismaService 来自全局 PrismaModule）。 */
@Module({
  controllers: [EvaluationController],
  providers: [EvaluationService],
})
export class EvaluationModule {}
