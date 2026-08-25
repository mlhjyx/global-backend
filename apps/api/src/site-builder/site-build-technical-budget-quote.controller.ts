import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { RequireScopes } from '../auth/require-scopes.decorator';
import { ScopesGuard } from '../auth/scopes.guard';
import { ApiEnvelope } from '../common/api-envelope.decorator';
import { envelope, type Enveloped } from '../common/envelope';
import { buildRequestHash, normalizeBuildRequest } from './build-request-contract';
import { CreateBuildDto } from './dto/build.dto';
import { IntakeDto } from './dto/intake.dto';
import { intakeRequestHash } from './intake.service';
import {
  SiteBuildTechnicalBudgetQuoteService,
  type SiteBuildTechnicalBudgetQuote,
} from './site-build-technical-budget-quote';

class SiteBuildTechnicalBudgetQuoteResponseDto {
  @ApiProperty({ enum: ['site-builder-technical-budget-quote/v1'] })
  schemaVersion!: 'site-builder-technical-budget-quote/v1';

  @ApiProperty({ enum: ['intake', 'refurbish'] })
  operation!: 'intake' | 'refurbish';

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  siteId!: string | null;

  @ApiProperty({ pattern: '^[0-9a-f]{64}$' })
  requestSha256!: string;

  @ApiProperty({ enum: ['USD'] })
  currency!: 'USD';

  @ApiProperty({ enum: ['microusd'] })
  unit!: 'microusd';

  @ApiProperty({ pattern: '^[1-9][0-9]*$' })
  requiredCapMicrousd!: string;

  @ApiProperty({ pattern: '^[0-9a-f]{64}$' })
  policyRevision!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt!: string;
}

function quoteErrorSchema(codes: readonly string[]) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'message'],
        properties: {
          code: {
            type: 'string',
            enum: [...codes],
          },
          message: { type: 'string' },
        },
      },
    },
  };
}

/**
 * Authenticated, zero-side-effect quote boundary used by the SaaS control
 * plane before it signs a one-time Budget Grant.
 */
@ApiTags('SiteBuilder')
@ApiBearerAuth()
@Controller('site-builder')
@UseGuards(AuthGuard, ScopesGuard)
@RequireScopes('acquisition:write')
export class SiteBuildTechnicalBudgetQuoteController {
  constructor(
    private readonly quotes: SiteBuildTechnicalBudgetQuoteService,
  ) {}

  @Post('intake-budget-quote')
  @HttpCode(200)
  @ApiOperation({
    summary: '计算 intake 的内部技术预算包络；零模型、零工作流、零持久写入',
  })
  @ApiEnvelope(SiteBuildTechnicalBudgetQuoteResponseDto)
  @ApiResponse({
    status: 400,
    description: '规范化后的 quote scope 非法',
    schema: quoteErrorSchema(['SITE_BUILD_BUDGET_QUOTE_INVALID']),
  })
  @ApiResponse({
    status: 503,
    description: '正式 execution envelope 无法证明',
    schema: quoteErrorSchema([
      'SITE_BUILD_BUDGET_QUOTE_UNAVAILABLE',
      'SITE_BUILD_BUDGET_POLICY_DRIFT',
    ]),
  })
  quoteIntake(
    @Body() dto: IntakeDto,
  ): Enveloped<SiteBuildTechnicalBudgetQuote> {
    return envelope(this.quotes.quoteIntake(intakeRequestHash(dto)));
  }

  @Post('sites/:id/build-budget-quote')
  @HttpCode(200)
  @ApiOperation({
    summary: '计算 refurbish 的内部技术预算包络；不构成客户报价或余额限制',
  })
  @ApiEnvelope(SiteBuildTechnicalBudgetQuoteResponseDto)
  @ApiResponse({
    status: 400,
    description: '规范化后的 quote scope 非法',
    schema: quoteErrorSchema(['SITE_BUILD_BUDGET_QUOTE_INVALID']),
  })
  @ApiResponse({
    status: 503,
    description: '正式 execution envelope 无法证明',
    schema: quoteErrorSchema([
      'SITE_BUILD_BUDGET_QUOTE_UNAVAILABLE',
      'SITE_BUILD_BUDGET_POLICY_DRIFT',
    ]),
  })
  quoteRefurbish(
    @Param('id', ParseUUIDPipe) siteId: string,
    @Body() dto: CreateBuildDto,
  ): Enveloped<SiteBuildTechnicalBudgetQuote> {
    const normalized = normalizeBuildRequest(dto);
    return envelope(
      this.quotes.quoteRefurbish(
        siteId,
        buildRequestHash(siteId, normalized),
      ),
    );
  }
}
