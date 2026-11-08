import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { envelope, type Enveloped } from '../common/envelope';
import { ExecutionBudgetAuthorityService } from '../execution-budget/execution-budget-authority.service';
import { workspaceExecutionBudgetRequestScope } from '../execution-budget/execution-budget-request-scope';
import {
  asExecutionBudgetHttpBoundary,
  EXECUTION_BUDGET_GRANT_HEADER,
} from '../execution-budget/execution-budget-grant.decorator';
import { CampaignPlanServiceTokenGuard } from './campaign-plan-service-token.guard';
import { CampaignPlanLauncher } from './campaign-plan.launcher';

/**
 * M2.1：gain-saas 控制面触发受限 Campaign 规划（设计 §3/§4.2）。
 *
 * 服务身份（x-service-token）+ 一次性预算 Grant（X-Execution-Budget-Grant，purpose
 * `campaign.plan`，subject = campaign，请求哈希绑定 jobId）；验证通过后消费 Grant、
 * 启动 `campaignPlanningWorkflow`，本端点自身不产计划、不写任何业务表。
 */

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// eslint-disable-next-line no-control-regex -- reject ASCII control characters at the boundary
const NO_CONTROL_CHARS = /^[^\u0000-\u001f\u007f]*$/u;

export interface CampaignPlanDraftBody {
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly jobId: string;
  readonly objective: string;
  readonly icpId?: string;
  readonly audienceSizeCap?: number;
  readonly budgetCapMicros?: number;
}

function requestInvalid(): never {
  throw new BadRequestException({
    error: {
      code: 'CAMPAIGN_PLAN_REQUEST_INVALID',
      message: 'CAMPAIGN_PLAN_REQUEST_INVALID',
    },
  });
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) requestInvalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) requestInvalid();
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    requestInvalid();
  }
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) requestInvalid();
  return value;
}

function optionalPositiveInteger(value: unknown, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    requestInvalid();
  }
  return value as number;
}

function optionalBudgetMicros(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) requestInvalid();
  return value as number;
}

export function parseCampaignPlanDraftBody(value: unknown): CampaignPlanDraftBody {
  const input = record(value);
  exactKeys(
    input,
    ['workspaceId', 'campaignId', 'jobId', 'objective'],
    ['icpId', 'audienceSizeCap', 'budgetCapMicros'],
  );
  const objective = input.objective;
  if (
    typeof objective !== 'string' ||
    objective.trim().length === 0 ||
    objective.length > 500 ||
    !NO_CONTROL_CHARS.test(objective)
  ) {
    requestInvalid();
  }
  return Object.freeze({
    workspaceId: uuid(input.workspaceId),
    campaignId: uuid(input.campaignId),
    jobId: uuid(input.jobId),
    objective,
    ...(input.icpId === undefined ? {} : { icpId: uuid(input.icpId) }),
    ...(input.audienceSizeCap === undefined
      ? {}
      : { audienceSizeCap: optionalPositiveInteger(input.audienceSizeCap, 1000) }),
    ...(input.budgetCapMicros === undefined
      ? {}
      : { budgetCapMicros: optionalBudgetMicros(input.budgetCapMicros) }),
  });
}

@ApiTags('Campaign')
@Controller('internal/campaign-plans')
@UseGuards(CampaignPlanServiceTokenGuard)
export class CampaignPlanInternalController {
  constructor(
    private readonly authority: ExecutionBudgetAuthorityService,
    private readonly launcher: CampaignPlanLauncher,
  ) {}

  @Post('draft')
  @HttpCode(202)
  @ApiOperation({
    operationId: 'requestCampaignPlanDraft',
    summary: '服务身份触发一次受限 Campaign 规划（异步 job，gain-saas 控制面专用）',
    description:
      '供 gain-saas 控制面调用：校验并消费一次性 execution-budget Grant（purpose campaign.plan），' +
      '启动 campaignPlanningWorkflow 后在回调中把原始计划 JSON 交付 gain-saas 落 DRAFT revision。' +
      '本端点不执行任何外部动作，也不在本侧计算 plan_hash。',
  })
  @ApiHeader({
    name: 'x-service-token',
    required: true,
    description: 'gain-saas 控制面服务令牌（env CAMPAIGN_PLAN_INTERNAL_SERVICE_TOKEN）',
  })
  @ApiHeader({
    name: EXECUTION_BUDGET_GRANT_HEADER.toLowerCase(),
    required: true,
    description: 'SaaS 签发的一次性 workspace 执行预算 Grant（purpose campaign.plan）',
  })
  @ApiBody({
    required: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['workspaceId', 'campaignId', 'jobId', 'objective'],
      properties: {
        workspaceId: { type: 'string', format: 'uuid' },
        campaignId: { type: 'string', format: 'uuid' },
        jobId: { type: 'string', format: 'uuid' },
        objective: { type: 'string', minLength: 1, maxLength: 500 },
        icpId: { type: 'string', format: 'uuid' },
        audienceSizeCap: { type: 'integer', minimum: 1, maximum: 1000 },
        budgetCapMicros: { type: 'integer', minimum: 0 },
      },
    },
  })
  @ApiResponse({
    status: 202,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['data'],
      properties: {
        data: {
          type: 'object',
          additionalProperties: false,
          required: ['jobId'],
          properties: { jobId: { type: 'string', format: 'uuid' } },
        },
      },
    },
  })
  async requestDraft(
    @Body() body: unknown,
    @Headers(EXECUTION_BUDGET_GRANT_HEADER.toLowerCase()) grant?: string,
  ): Promise<Enveloped<{ jobId: string }>> {
    const parsed = parseCampaignPlanDraftBody(body);
    const scope = workspaceExecutionBudgetRequestScope({
      operation: 'POST /campaigns/:campaignId/plan-drafts',
      campaignId: parsed.campaignId,
      body: { jobId: parsed.jobId },
    });
    const binding = await asExecutionBudgetHttpBoundary(async () => {
      const verified = await this.authority.verifyWorkspaceGrant({
        compactJws: grant,
        identity: { workspaceId: parsed.workspaceId },
        scope,
      });
      return this.authority.consumeVerifiedWorkspaceGrant(verified);
    });
    await this.launcher.launch({ ...parsed, executionBudget: binding });
    return envelope({ jobId: parsed.jobId });
  }
}
