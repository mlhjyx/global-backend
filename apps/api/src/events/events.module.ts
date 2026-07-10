import { Module } from '@nestjs/common';
import { EventsService } from './events.service';
import { EventsController } from './events.controller';

/** 集成事件出口（收口③）：GET /events 拉取 + POST /events/ack。 */
@Module({
  controllers: [EventsController],
  providers: [EventsService],
})
export class EventsModule {}
