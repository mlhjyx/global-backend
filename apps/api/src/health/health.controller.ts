import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('System')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: '健康检查（存活）' })
  check(): { status: string; service: string; ts: string } {
    return { status: 'ok', service: 'global-api', ts: new Date().toISOString() };
  }

  @Get('db')
  @ApiOperation({ summary: '数据库连通性检查（以 app_user 连接）' })
  async db(): Promise<{ db: string }> {
    await this.prisma.$queryRaw`SELECT 1`;
    return { db: 'ok' };
  }
}
