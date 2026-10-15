import { Module } from '@nestjs/common';
import { OutboxRelayService } from './outbox-relay.service';
import { DevFastLaneTemporalClient } from '../temporal/dev-fast-lane-temporal.client';

@Module({
  providers: [OutboxRelayService, DevFastLaneTemporalClient],
})
export class RelayModule {}
