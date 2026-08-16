import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Min } from 'class-validator';
import type { AdaptiveQueryPlanResult } from '../adaptive-query-plan.service';
import { QueryPlanDto } from './qualification.dto';

export class CreateAdaptiveQueryPlanSuggestionDto {
  @ApiPropertyOptional({ minimum: 1, example: 1, description: '兼容字段；真实轮次由源计划 trace 推导，提供时必须完全一致' })
  @IsOptional()
  @IsInt()
  @Min(1)
  currentRound?: number;

  @ApiPropertyOptional({ minimum: 1, default: 3, description: '初始轮可设；后续轮继承源计划 trace，提供时必须完全一致' })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxRounds?: number;
}

export class AdaptiveQueryPlanSuggestionDto {
  @ApiProperty({ enum: ['DRAFT', 'CONVERGED'] })
  outcome!: 'DRAFT' | 'CONVERGED';

  @ApiProperty({ description: 'true 表示同一 run 的幂等重试，返回既有草案' })
  replayed!: boolean;

  @ApiProperty({
    enum: ['MAX_ROUNDS_REACHED', 'NO_SAFE_ADAPTATION', 'NO_ADAPTATION_NEEDED'],
    nullable: true,
  })
  convergenceReason!: AdaptiveQueryPlanResult['convergenceReason'];

  @ApiProperty({ type: QueryPlanDto, nullable: true, description: '仅 outcome=DRAFT 时存在，且状态固定为 DRAFT' })
  plan!: QueryPlanDto | null;

  static from(result: AdaptiveQueryPlanResult): AdaptiveQueryPlanSuggestionDto {
    return {
      outcome: result.outcome,
      replayed: result.replayed,
      convergenceReason: result.convergenceReason,
      plan: result.plan ? QueryPlanDto.from(result.plan) : null,
    };
  }
}
