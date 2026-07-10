import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

const KINDS = ['MUST_HAVE', 'NICE_TO_HAVE', 'EXCLUSION'];
const OPERATORS = ['eq', 'neq', 'in', 'not_in', 'contains', 'not_contains', 'gte', 'lte', 'matches'];

// ── QualificationRule ───────────────────────────────────────────────────────

export class CreateRuleDto {
  @ApiProperty({ enum: KINDS })
  @IsIn(KINDS)
  kind!: string;

  @ApiProperty({ example: 'industry', description: '规范属性名（industry/region/employee_count/...）' })
  @IsString()
  field!: string;

  @ApiProperty({ enum: OPERATORS })
  @IsIn(OPERATORS)
  operator!: string;

  @ApiProperty({ description: '操作数：标量或数组', oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'array', items: {} }], example: ['automotive', 'aerospace'] })
  value!: unknown;

  @ApiPropertyOptional({ default: 1, minimum: 0, description: 'NICE_TO_HAVE 计分权重（≥0；排除语义用 EXCLUSION 规则表达，负权重会静默污染归一化分母）' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  weight?: number;

  @ApiPropertyOptional({ description: '规则依据（推断透明）' })
  @IsOptional()
  @IsString()
  rationale?: string;
}

export class UpdateRuleDto {
  @ApiPropertyOptional({ enum: KINDS })
  @IsOptional()
  @IsIn(KINDS)
  kind?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  field?: string;

  @ApiPropertyOptional({ enum: OPERATORS })
  @IsOptional()
  @IsIn(OPERATORS)
  operator?: string;

  @ApiPropertyOptional({ description: '操作数：标量或数组', oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'array', items: {} }] })
  @IsOptional()
  value?: unknown;

  @ApiPropertyOptional({ minimum: 0, description: 'NICE_TO_HAVE 计分权重（≥0）' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  weight?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  rationale?: string;
}

export class RuleDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) icpId!: string;
  @ApiProperty({ enum: KINDS }) kind!: string;
  @ApiProperty() field!: string;
  @ApiProperty({ enum: OPERATORS }) operator!: string;
  @ApiProperty({ description: '操作数：标量或数组', oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'array', items: {} }] }) value!: unknown;
  @ApiProperty() weight!: number;
  @ApiPropertyOptional({ type: String, nullable: true }) rationale!: string | null;
  @ApiProperty() version!: number;

  static from(r: {
    id: string;
    icpId: string;
    kind: string;
    field: string;
    operator: string;
    value: unknown;
    weight: number;
    rationale: string | null;
    version: number;
  }): RuleDto {
    return {
      id: r.id,
      icpId: r.icpId,
      kind: r.kind,
      field: r.field,
      operator: r.operator,
      value: r.value,
      weight: r.weight,
      rationale: r.rationale,
      version: r.version,
    };
  }
}

// ── Backtest（LED-004）──────────────────────────────────────────────────────

export class BacktestSampleDto {
  @ApiProperty({ example: 'Muster Metallbau GmbH' })
  @IsString()
  name!: string;

  @ApiPropertyOptional({ example: 'muster-metallbau.de' })
  @IsOptional()
  @IsString()
  domain?: string;

  @ApiProperty({
    description: '已知的公司属性（industry/region/employee_count/...），规则据此确定性评估',
    example: { industry: 'metal fabrication', country: 'DE', employee_count: 120 },
  })
  @IsObject()
  attributes!: Record<string, unknown>;

  @ApiProperty({ enum: ['match', 'exclude'], description: '期望结果：已知客户=match，已知不合适=exclude' })
  @IsIn(['match', 'exclude'])
  expected!: 'match' | 'exclude';
}

export class RunBacktestDto {
  @ApiProperty({ type: [BacktestSampleDto], minItems: 1 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => BacktestSampleDto)
  samples!: BacktestSampleDto[];
}

export class BacktestDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) icpId!: string;
  @ApiProperty({ type: 'array', items: { type: 'object' }, description: '逐样例判定：verdict(match/exclude/no_match/review) + 每条规则的评估' })
  results!: unknown;
  @ApiProperty({ description: 'matchHitRate / excludeCatchRate / unknownFieldRate / recommendation' })
  metrics!: unknown;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;

  static from(b: { id: string; icpId: string; results: unknown; metrics: unknown; createdAt: Date }): BacktestDto {
    return {
      id: b.id,
      icpId: b.icpId,
      results: b.results,
      metrics: b.metrics,
      createdAt: b.createdAt.toISOString(),
    };
  }
}

// ── Query Plan（LED-005）────────────────────────────────────────────────────

export class QueryPlanDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) icpId!: string;
  @ApiProperty({ enum: ['DRAFT', 'READY', 'EXECUTED'] }) status!: string;
  @ApiProperty({ type: 'array', items: { type: 'object' }, description: '有序查询列表：source_class + filters + keywords + rationale + priority' })
  queries!: unknown;
  @ApiPropertyOptional({ type: Number, nullable: true }) estimatedVolume!: number | null;
  @ApiProperty() version!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;

  static from(p: {
    id: string;
    icpId: string;
    status: string;
    queries: unknown;
    estimatedVolume: number | null;
    version: number;
    createdAt: Date;
  }): QueryPlanDto {
    return {
      id: p.id,
      icpId: p.icpId,
      status: p.status,
      queries: p.queries,
      estimatedVolume: p.estimatedVolume,
      version: p.version,
      createdAt: p.createdAt.toISOString(),
    };
  }
}

// ── ICP 编辑 ────────────────────────────────────────────────────────────────

export class UpdateIcpDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ description: '目标公司属性' })
  @IsOptional()
  @IsObject()
  companyAttributes?: Record<string, unknown>;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  painPoints?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  triggerSignals?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  exclusions?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  valueProps?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  targetMarkets?: string[];

  @ApiPropertyOptional({ description: '乐观锁：当前版本号' })
  @IsOptional()
  @IsNumber()
  expectedVersion?: number;
}
