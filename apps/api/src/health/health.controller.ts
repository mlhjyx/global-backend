import {
  Controller,
  Get,
  HttpStatus,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import type { Response } from 'express';
import { ACQUISITION_CONTROLLER_SCOPE_INVENTORY } from '../auth/acquisition-scope-inventory';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import { RequireScopes } from '../auth/require-scopes.decorator';
import type { RequestContext } from '../auth/request-context';
import { PrismaService } from '../prisma/prisma.service';
import {
  RuntimeIdentityService,
  type BuildHealthResponse,
} from '../runtime/runtime-admission';
import {
  RuntimeOpsReadService,
  type RuntimeOpsHttpSnapshot,
} from '../runtime-ops/runtime-ops-read.service';
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
              'WORKER_HEARTBEAT_NOT_READY',
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

const NON_NEGATIVE_INTEGER: SchemaObject = {
  type: 'integer',
  minimum: 0,
};

const RUNTIME_OPS_SCHEMA: SchemaObject = {
  type: 'object',
  required: [
    'schemaVersion',
    'observedAt',
    'runtime',
    'workspace',
    'global',
    'proof',
  ],
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'string', enum: ['runtime-ops/v1'] },
    observedAt: { type: 'string', format: 'date-time' },
    runtime: {
      type: 'object',
      required: [
        'status',
        'workers',
        'schedules',
        'workflows',
        'signalIngest',
      ],
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: ['UNVERIFIED', 'DEGRADED'] },
        workers: {
          type: 'object',
          required: ['expectedBuildSha', 'queues', 'observedBuildShas'],
          additionalProperties: false,
          properties: {
            expectedBuildSha: { type: 'string' },
            queues: {
              type: 'array',
              items: {
                type: 'object',
                required: ['taskQueue', 'state'],
                additionalProperties: false,
                properties: {
                  taskQueue: {
                    type: 'string',
                    enum: [
                      'understanding',
                      'acquisition',
                      'site-builder',
                      'maintenance',
                    ],
                  },
                  state: {
                    type: 'string',
                    enum: [
                      'POLLING',
                      'STALE',
                      'MISSING',
                      'BUILD_MISMATCH',
                    ],
                  },
                },
              },
            },
            observedBuildShas: {
              type: 'array',
              items: { type: 'string' },
            },
          },
        },
        schedules: {
          type: 'object',
          required: [
            'expected',
            'tracked',
            'drifted',
            'paused',
            'late',
            'staleEvidence',
            'unobservable',
            'missedCatchup',
            'skippedOverlap',
          ],
          additionalProperties: false,
          properties: {
            expected: NON_NEGATIVE_INTEGER,
            tracked: NON_NEGATIVE_INTEGER,
            drifted: NON_NEGATIVE_INTEGER,
            paused: NON_NEGATIVE_INTEGER,
            late: NON_NEGATIVE_INTEGER,
            staleEvidence: NON_NEGATIVE_INTEGER,
            unobservable: NON_NEGATIVE_INTEGER,
            missedCatchup: NON_NEGATIVE_INTEGER,
            skippedOverlap: NON_NEGATIVE_INTEGER,
          },
        },
        workflows: {
          type: 'object',
          required: ['failed24h', 'budgetTruncated24h'],
          additionalProperties: false,
          properties: {
            failed24h: NON_NEGATIVE_INTEGER,
            budgetTruncated24h: NON_NEGATIVE_INTEGER,
          },
        },
        signalIngest: {
          type: 'object',
          required: ['pending', 'expiredLeases', 'errors'],
          additionalProperties: false,
          properties: {
            pending: NON_NEGATIVE_INTEGER,
            expiredLeases: NON_NEGATIVE_INTEGER,
            errors: NON_NEGATIVE_INTEGER,
          },
        },
      },
    },
    workspace: {
      type: 'object',
      required: ['outbox', 'acquisitionBudget'],
      additionalProperties: false,
      properties: {
        outbox: {
          type: 'object',
          required: ['parked', 'dead'],
          additionalProperties: false,
          properties: {
            parked: NON_NEGATIVE_INTEGER,
            dead: NON_NEGATIVE_INTEGER,
          },
        },
        acquisitionBudget: {
          type: 'object',
          required: ['exhausted', 'frozen', 'unknownSettlement'],
          additionalProperties: false,
          properties: {
            exhausted: NON_NEGATIVE_INTEGER,
            frozen: NON_NEGATIVE_INTEGER,
            unknownSettlement: NON_NEGATIVE_INTEGER,
          },
        },
      },
    },
    global: {
      type: 'object',
      required: ['suspendedSourcePolicies'],
      additionalProperties: false,
      properties: {
        suspendedSourcePolicies: NON_NEGATIVE_INTEGER,
      },
    },
    proof: {
      type: 'object',
      required: [
        'outboxRelay',
        'gatewayAdmission',
        'providerConsecutiveZeroResults',
      ],
      additionalProperties: false,
      properties: {
        outboxRelay: { type: 'string', enum: ['UNVERIFIED'] },
        gatewayAdmission: { type: 'string', enum: ['UNVERIFIED'] },
        providerConsecutiveZeroResults: {
          type: 'string',
          enum: ['UNOBSERVABLE'],
        },
      },
    },
  },
};

const HEALTH_SCOPES =
  ACQUISITION_CONTROLLER_SCOPE_INVENTORY.HealthController.operations;

/** 基础设施探针：**不套统一信封**（LB/监控直读，见 common/envelope.ts 的定稿说明）。 */
@ApiTags('System')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runtimeIdentity: RuntimeIdentityService,
    private readonly readiness: ReadinessService,
    private readonly runtimeOps: RuntimeOpsReadService,
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

  @Get('ops')
  @ApiBearerAuth()
  @RequireScopes(...HEALTH_SCOPES.ops)
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: '受限运行态快照（聚合、无个人数据、保守证明状态）',
  })
  @ApiOkResponse({ schema: RUNTIME_OPS_SCHEMA })
  async ops(@Ctx() ctx: RequestContext): Promise<RuntimeOpsHttpSnapshot> {
    return this.runtimeOps.snapshotForWorkspace(ctx.workspaceId);
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
