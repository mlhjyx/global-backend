import { Module } from "@nestjs/common";
import { ExecutionBudgetModule } from "../execution-budget/execution-budget.module";
import { MarketCandidatesModule } from "../market-candidates/market-candidates.module";
import { MarketCandidateGenerationsController } from "./generation.controller";
import { MarketCandidateGenerationRepository } from "./generation.repository";
import { MarketCandidateGenerationService } from "./generation.service";

@Module({
  imports: [ExecutionBudgetModule, MarketCandidatesModule],
  controllers: [MarketCandidateGenerationsController],
  providers: [
    MarketCandidateGenerationRepository,
    MarketCandidateGenerationService,
  ],
  exports: [MarketCandidateGenerationService],
})
export class MarketCandidateGenerationModule {}
