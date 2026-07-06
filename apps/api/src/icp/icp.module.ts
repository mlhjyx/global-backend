import { Module } from '@nestjs/common';
import { IcpController } from './icp.controller';
import { IcpService } from './icp.service';

@Module({
  controllers: [IcpController],
  providers: [IcpService],
})
export class IcpModule {}
