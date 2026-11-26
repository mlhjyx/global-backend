import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  ICP_REJUDGE_BATCH_SIZE_DEFAULT,
  ICP_REJUDGE_BATCH_SIZE_LIMIT,
  ICP_REJUDGE_MAX_COMPANIES_DEFAULT,
  ICP_REJUDGE_MAX_COMPANIES_LIMIT,
  type IcpRejudgeHttpRequestBody,
} from '../execution-budget/icp-rejudge-budget-request';

export class RejudgeIcpLeadsDto {
  @ApiProperty({
    minLength: 1,
    maxLength: 128,
    description: '必填幂等键（每次触发生成新值，保证同 ICP 多次重判拥有独立预算账户与防重复扣账）',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  attemptId!: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: ICP_REJUDGE_MAX_COMPANIES_LIMIT,
    default: ICP_REJUDGE_MAX_COMPANIES_DEFAULT,
    description: '本次重判最大公司数（硬顶 100；越界直接 400 拒绝，不静默夹取）',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(ICP_REJUDGE_MAX_COMPANIES_LIMIT)
  maxCompanies?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: ICP_REJUDGE_BATCH_SIZE_LIMIT,
    default: ICP_REJUDGE_BATCH_SIZE_DEFAULT,
    description: '每批公司数（1..25，默认 25，透传给 planRejudgeBatches）',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(ICP_REJUDGE_BATCH_SIZE_LIMIT)
  batchSize?: number;

  @ApiPropertyOptional({
    default: true,
    description: '重判前是否刷新缺失的 T1/T2 核验（VIES / GLEIF / Wikidata）',
  })
  @IsOptional()
  @IsBoolean()
  refreshCorroboration?: boolean;

  @ApiPropertyOptional({
    default: false,
    description: '为 true 时对尚未升级到 website-profile/v2 且缺 vat_id 的公司重抓首页与欧盟法律页',
  })
  @IsOptional()
  @IsBoolean()
  refreshWebsiteProfile?: boolean;

  @ApiPropertyOptional({
    default: false,
    description: '仅允许与显式 companyIds 联用：强制重判当前 input_digest 已新鲜的指定公司',
  })
  @IsOptional()
  @IsBoolean()
  includeFresh?: boolean;

  @ApiPropertyOptional({
    type: [String],
    minItems: 1,
    maxItems: ICP_REJUDGE_MAX_COMPANIES_LIMIT,
    description: '可选定向公司 UUID v4 白名单（用于小批灰度；空数组直接 400 拒绝）',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(ICP_REJUDGE_MAX_COMPANIES_LIMIT)
  @IsUUID('4', { each: true })
  companyIds?: string[];
}

/**
 * Global NestJS `ValidationPipe({ transform: true, whitelist: true })` converts
 * `@Body()` into a `RejudgeIcpLeadsDto` class instance. Convert only authentic
 * DTO instances to plain objects (omitting `undefined` keys) before handing to
 * the strict plain-object normalizer shared with the quote controller.
 */
export function toPlainRejudgeRequestBody(
  dto: RejudgeIcpLeadsDto | IcpRejudgeHttpRequestBody,
): IcpRejudgeHttpRequestBody {
  if (dto instanceof RejudgeIcpLeadsDto) {
    const plain: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dto)) {
      if (value !== undefined) plain[key] = value;
    }
    return plain as unknown as IcpRejudgeHttpRequestBody;
  }
  return dto;
}

export class RejudgeIcpLeadsResponseDto {
  @ApiProperty({ format: 'uuid' })
  rejudgeId!: string;

  @ApiProperty({ format: 'uuid' })
  icpId!: string;

  @ApiProperty({ enum: ['ACCEPTED'] })
  status!: 'ACCEPTED';

  @ApiProperty({ minimum: 1 })
  candidateCount!: number;

  @ApiProperty({ minimum: 1 })
  batchCount!: number;

  @ApiProperty({ pattern: '^[0-9]+$' })
  estimatedCostMicros!: string;

  @ApiProperty()
  refreshCorroboration!: boolean;

  @ApiProperty()
  refreshWebsiteProfile!: boolean;
}
