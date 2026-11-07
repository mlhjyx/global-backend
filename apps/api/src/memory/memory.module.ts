import { Module } from '@nestjs/common';
import { MemoryEpisodeConsumer } from './memory-episode.consumer';
import { MemoryQueryService } from './memory-query.service';

/**
 * D-MA-7 memory layer v0: episodic outbox consumer + SQL retrieval.
 * The consumer is disabled unless MEMORY_LAYER_V0_ENABLED=true.
 */
@Module({
  providers: [MemoryEpisodeConsumer, MemoryQueryService],
  exports: [MemoryQueryService],
})
export class MemoryModule {}
