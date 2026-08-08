import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import {
  RuntimeIdentityService,
  type BuildHealthResponse,
} from '../runtime/runtime-admission';
import { ReadinessService, type ReadinessResponse } from './readiness.service';

interface LivenessResponse {
  readonly status: 'ok';
  readonly service: 'global-api';
  readonly ts: string;
}

const LEGACY_HEALTH_SCHEMA: SchemaObject = {
  type: 'object',
  properties: {
    status: { type: 'string', example: 'ok' },
    service: { type: 'string', example: 'global-api' },
    ts: { type: 'string', format: 'date-time' },
  },
};

const LIVENESS_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['status', 'service', 'ts'],
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['ok'] },
    service: { type: 'string', enum: ['global-api'] },
    ts: { type: 'string', format: 'date-time' },
  },
};

const BUILD_HEALTH_SCHEMA: SchemaObject = {
  type: 'object',
  required: [
    'status',
    'service',
    'deploymentStage',
    'identity',
    'missingFields',
  ],
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['VERIFIED', 'UNVERIFIED'] },
    service: { type: 'string', enum: ['global-api'] },
    deploymentStage: {
      type: 'string',
      enum: ['development', 'pilot', 'production'],
    },
    identity: {
      type: 'object',
      required: [
        'buildSha',
        'buildTime',
        'artifactDigest',
        'migrationManifestDigest',
        'migrationRevision',
        'migrationCount',
      ],
      additionalProperties: false,
      properties: {
        buildSha: { type: 'string', nullable: true },
        buildTime: { type: 'string', format: 'date-time', nullable: true },
        artifactDigest: { type: 'string', nullable: true },
        migrationManifestDigest: { type: 'string', nullable: true },
        migrationRevision: { type: 'string', nullable: true },
        migrationCount: { type: 'integer', nullable: true, minimum: 1 },
      },
    },
    missingFields: {
      type: 'array',
      items: {
        type: 'string',
        enum: [
          'BUILD_SHA',
          'BUILD_TIME',
          'ARTIFACT_DIGEST',
          'MIGRATION_MANIFEST_DIGEST',
        ],
      },
    },
  },
};

const READINESS_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['status', 'service', 'ts', 'checks'],
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['READY', 'NOT_READY'] },
    service: { type: 'string', enum: ['global-api'] },
    ts: { type: 'string', format: 'date-time' },
    checks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'required', 'status', 'code'],
        additionalProperties: false,
        properties: {
          name: {
            type: 'string',
            enum: [
              'configuration',
              'build_identity',
              'database',
              'temporal',
              'worker_heartbeat',
              'outbox_relay',
              'gateway_admission',
            ],
          },
          required: { type: 'boolean' },
          status: { type: 'string', enum: ['PASS', 'FAIL', 'UNVERIFIED'] },
          code: {
            type: 'string',
            enum: [
              'CONFIGURATION_VALID',
              'BUILD_IDENTITY_VERIFIED',
              'BUILD_IDENTITY_NOT_REQUIRED',
              'BUILD_IDENTITY_REQUIRED',
              'DATABASE_REACHABLE_AND_MIGRATED',
              'DATABASE_MIGRATION_DIRTY',
              'MIGRATION_MANIFEST_MISMATCH',
              'MIGRATION_CHECKSUM_MISMATCH',
              'DATABASE_REACHABLE_MIGRATION_UNVERIFIED',
              'TEMPORAL_REACHABLE',
              'WORKER_HEARTBEAT_VERIFIED',
              'OUTBOX_RELAY_VERIFIED',
              'GATEWAY_ADMISSION_VERIFIED',
              'PROOF_SOURCE_UNAVAILABLE',
              'PROBE_FAILED',
              'PROBE_TIMEOUT',
            ],
          },
        },
      },
    },
  },
};

/** 基础设施探针：**不套统一信封**（LB/监控直读，见 common/envelope.ts 的定稿说明）。 */
@ApiTags('System')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runtimeIdentity: RuntimeIdentityService,
    private readonly readiness: ReadinessService,
  ) {}

  @Get()
  @ApiOperation({ summary: '健康检查（存活）' })
  @ApiOkResponse({
    schema: LEGACY_HEALTH_SCHEMA,
  })
  check(): LivenessResponse {
    return this.live();
  }

  @Get('live')
  @ApiOperation({ summary: '进程存活检查（不访问外部依赖）' })
  @ApiOkResponse({ schema: LIVENESS_SCHEMA })
  live(): LivenessResponse {
    return {
      status: 'ok',
      service: 'global-api',
      ts: new Date().toISOString(),
    };
  }

  @Get('build')
  @ApiOperation({ summary: '构建与迁移身份（只读 receipt，自校验 artifact）' })
  @ApiOkResponse({ schema: BUILD_HEALTH_SCHEMA })
  build(): BuildHealthResponse {
    return this.runtimeIdentity.getBuildHealth();
  }

  @Get('ready')
  @ApiOperation({ summary: '保守就绪门（所有必需证明均通过才返回 200）' })
  @ApiOkResponse({ schema: READINESS_SCHEMA })
  @ApiResponse({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    description: '一个或多个必需就绪证明失败或尚不可验证',
    schema: READINESS_SCHEMA,
  })
  async ready(
    @Res({ passthrough: true }) response: Response,
  ): Promise<ReadinessResponse> {
    const result = await this.readiness.check();
    response.status(
      result.status === 'READY'
        ? HttpStatus.OK
        : HttpStatus.SERVICE_UNAVAILABLE,
    );
    return result;
  }

  @Get('db')
  @ApiOperation({ summary: '数据库连通性检查（以 app_user 连接）' })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: { db: { type: 'string', example: 'ok' } },
    },
  })
  async db(): Promise<{ db: string }> {
    await this.prisma.$queryRaw`SELECT 1`;
    return { db: 'ok' };
  }
}
