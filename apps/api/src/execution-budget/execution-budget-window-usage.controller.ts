import {
  BadRequestException,
  Controller,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiProperty,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ApiEnvelope } from '../common/api-envelope.decorator';
import { envelope, type Enveloped } from '../common/envelope';
import { BudgetReadbackServiceTokenGuard } from './budget-readback-service-token.guard';
import {
  EXECUTION_BUDGET_WINDOW_USAGE_SCHEMA,
  ExecutionBudgetWindowUsageService,
  type ExecutionBudgetWindowUsage,
} from './execution-budget-window-usage.service';

/**
 * ch08 §3.1.1 C1a：窗口实扣读回（gain-saas `WorkspaceBudgetPolicyService.assertGrantAllowed`
 * 在签发 Grant 前调用）。服务身份守卫 + 回环限制；只读，不写任何表。
 */

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invalidQuery(): never {
  throw new BadRequestException({
    error: {
      code: 'EXECUTION_BUDGET_WINDOW_USAGE_INVALID',
      message: 'EXECUTION_BUDGET_WINDOW_USAGE_INVALID',
    },
  });
}

export interface WindowUsageQuery {
  readonly workspaceId: string;
  readonly since: Date;
}

/** 只接受 UUID + ISO8601；since 未来时间直接拒绝（窗口左端在未来没有意义）。 */
export function parseWindowUsageQuery(raw: unknown): WindowUsageQuery {
  const record =
    raw != null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : invalidQuery();
  const workspaceId = record.workspaceId;
  if (typeof workspaceId !== 'string' || !UUID.test(workspaceId)) invalidQuery();
  const sinceRaw = record.since;
  if (typeof sinceRaw !== 'string' || sinceRaw.length === 0 || sinceRaw.length > 64) {
    invalidQuery();
  }
  const sinceMs = Date.parse(sinceRaw);
  if (!Number.isFinite(sinceMs)) invalidQuery();
  if (sinceMs > Date.now()) invalidQuery();
  return { workspaceId, since: new Date(sinceMs) };
}

class ExecutionBudgetWindowUsageResponseDto {
  @ApiProperty({ enum: [EXECUTION_BUDGET_WINDOW_USAGE_SCHEMA] })
  schemaVersion!: typeof EXECUTION_BUDGET_WINDOW_USAGE_SCHEMA;

  @ApiProperty({ format: 'uuid' })
  workspaceId!: string;

  @ApiProperty({ format: 'date-time' })
  since!: string;

  @ApiProperty({
    type: String,
    example: '2410250',
    description: '窗口内实扣合计（µUSD，字符串承载 bigint）',
  })
  chargedMicrousd!: string;

  @ApiProperty({
    type: String,
    example: '500000',
    description: '窗口内仍在途（RESERVED）的预留合计（µUSD）',
  })
  reservedMicrousd!: string;

  @ApiProperty({
    type: Object,
    additionalProperties: { type: 'string' },
    example: { 'discovery.run': '2100000', 'understanding.run': '310250' },
    description: '按 purpose 的实扣构成（µUSD 字符串）',
  })
  byPurpose!: Record<string, string>;
}

@ApiTags('ExecutionBudget')
@Controller('execution-budget')
@UseGuards(BudgetReadbackServiceTokenGuard)
export class ExecutionBudgetWindowUsageController {
  constructor(private readonly usage: ExecutionBudgetWindowUsageService) {}

  @Get('window-usage')
  @ApiOperation({
    summary:
      '窗口实扣读回（服务身份）：SUM(tool_budget_operation.charged_microusd) 按 workspace/时间窗；窗口花费的唯一权威口径',
    description:
      '供 gain-saas 在签发执行预算 Grant 前判定窗口余额（ch08 C1a）。返回窗口内已结算实扣（SETTLED/RESULT_UNKNOWN）、仍在途的预留与按 purpose 的构成；只读、不写任何表。服务身份（x-service-token）且仅限回环调用；未配置令牌时返回 503（fail-closed）。',
  })
  @ApiQuery({ name: 'workspaceId', format: 'uuid' })
  @ApiQuery({ name: 'since', format: 'date-time', description: 'ISO8601（UTC）' })
  @ApiEnvelope(ExecutionBudgetWindowUsageResponseDto)
  @ApiResponse({
    status: 400,
    description: 'EXECUTION_BUDGET_WINDOW_USAGE_INVALID',
  })
  @ApiResponse({ status: 401, description: 'SERVICE_TOKEN_REQUIRED / SERVICE_TOKEN_INVALID' })
  @ApiResponse({ status: 403, description: 'BUDGET_READBACK_LOOPBACK_ONLY' })
  @ApiResponse({ status: 503, description: 'BUDGET_READBACK_NOT_CONFIGURED' })
  windowUsage(@Query() raw: unknown): Promise<Enveloped<ExecutionBudgetWindowUsage>> {
    const query = parseWindowUsageQuery(raw);
    return this.usage.windowUsage(query).then(envelope);
  }
}
