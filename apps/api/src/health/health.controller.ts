import { Controller, Get, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { BuildIdentityService } from '../runtime/build-attestation';
import { RuntimeReadinessService } from './runtime-readiness.service';

/** 基础设施探针：**不套统一信封**（LB/监控直读，见 common/envelope.ts 的定稿说明）。 */
@ApiTags('System')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly readinessService: RuntimeReadinessService,
    private readonly buildIdentity: BuildIdentityService,
  ) {}

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

  @Get('live')
  @ApiOperation({ summary: '进程存活检查（不探测任何依赖）' })
  @ApiOkResponse({
    schema: {
      type: 'object',
      required: ['status', 'service', 'ts'],
      properties: {
        status: { type: 'string', enum: ['ok'] },
        service: { type: 'string', enum: ['global-api'] },
        ts: { type: 'string', format: 'date-time' },
      },
    },
  })
  live(): { status: string; service: string; ts: string } {
    return this.check();
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

  @Get('build')
  @ApiOperation({ summary: '非敏感构建身份回执' })
  @ApiOkResponse({
    schema: {
      type: 'object',
      required: ['status', 'service', 'build'],
      properties: {
        status: { type: 'string', enum: ['ok'] },
        service: { type: 'string', enum: ['global-api'] },
        build: { type: 'object', additionalProperties: true },
      },
    },
  })
  build() {
    return { status: 'ok', service: 'global-api', build: this.buildIdentity.current() };
  }

  @Get('ready')
  @ApiOperation({ summary: '接流就绪检查（DB、Temporal control plane 与受控 admission）' })
  @ApiOkResponse({ description: 'API-local readiness 通过' })
  @ApiServiceUnavailableResponse({ description: '至少一项必需证据失败或尚未证明' })
  async ready(@Res({ passthrough: true }) response: Response) {
    const report = await this.readinessService.check();
    if (report.status !== 'ready') response.status(503);
    return report;
  }
}
