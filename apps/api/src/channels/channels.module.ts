import { Module } from '@nestjs/common';
import { ChannelService } from './channel.service';
import { ChannelsController } from './channels.controller';

/** M1 渠道数据源平台（注册/启用/导入；抓取执行见 ChannelService.requestCrawl 的门槛说明）。 */
@Module({
  controllers: [ChannelsController],
  providers: [ChannelService],
  exports: [ChannelService],
})
export class ChannelsModule {}
