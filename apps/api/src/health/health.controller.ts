import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';

/** 基础设施探针：**不套统一信封**（LB/监控直读，见 common/envelope.ts 的定稿说明）。 */
@ApiTags('System')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: '健康检查（存活）' })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', example: 'ok' },
        service: { type: 'string', example: 'global-api' },
        ts: { type: 'string', format: 'date-time' },
      },
    },
  })
  check(): { status: string; service: string; ts: string } {
    return { status: 'ok', service: 'global-api', ts: new Date().toISOString() };
  }

  @Get('db')
  @ApiOperation({ summary: '数据库连通性检查（以 app_user 连接）' })
  @ApiOkResponse({
    schema: { type: 'object', properties: { db: { type: 'string', example: 'ok' } } },
  })
  async db(): Promise<{ db: string }> {
    await this.prisma.$queryRaw`SELECT 1`;
    return { db: 'ok' };
  }
}
