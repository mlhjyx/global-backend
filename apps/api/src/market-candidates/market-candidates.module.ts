import { Module } from '@nestjs/common';
import { MarketCandidateSetsController } from './market-candidate-sets.controller';
import { MarketCandidateSetsService } from './market-candidate-sets.service';

@Module({
  controllers: [MarketCandidateSetsController],
  providers: [MarketCandidateSetsService],
  exports: [MarketCandidateSetsService],
})
export class MarketCandidatesModule {}
