import { Module } from '@nestjs/common';
import { join } from 'node:path';
import { ChannelHealthSweepService } from './channel-health-sweep.service';
import { ChannelProbeService } from './channel-probe.service';
import { ChannelService } from './channel.service';
import { ChannelsController } from './channels.controller';
import {
  CHANNEL_SECRET_RESOLVER,
  CompositeChannelSecretResolver,
  EnvChannelSecretResolver,
  FileChannelSecretResolver,
} from './connector/secret-resolver';

/** 渠道密钥引用解析器：env（测试/临时覆盖）→ file（正式来源，.secrets/channel-secrets）。 */
export const channelSecretResolverProvider = {
  provide: CHANNEL_SECRET_RESOLVER,
  useFactory: () =>
    new CompositeChannelSecretResolver([
      new EnvChannelSecretResolver(),
      new FileChannelSecretResolver({
        rootDir: process.env.CHANNEL_SECRETS_DIR ?? join(process.cwd(), '.secrets', 'channel-secrets'),
      }),
    ]),
};

/**
 * 渠道数据源平台（注册/启用/导入/manifest/probe/健康扫描）。
 * 出网通道（CHANNEL_HTTP_CLIENT）刻意不在此提供：本波未接平台围栏，
 * probe 端点 fail-closed 503，等 CH-5 在平台 worker 里接 Grant/fence 后注入。
 */
@Module({
  controllers: [ChannelsController],
  providers: [ChannelService, ChannelProbeService, ChannelHealthSweepService, channelSecretResolverProvider],
  exports: [ChannelService, ChannelProbeService],
})
export class ChannelsModule {}
