import { ApiProperty } from '@nestjs/swagger';
import { PROVIDER_QUALITY_METRICS, type ProviderQualityMetric } from './provider-quality.service';

export class ProviderQualityWindowDto {
  @ApiProperty({ format: 'date-time' }) from!: string;
  @ApiProperty({ format: 'date-time' }) to!: string;
  @ApiProperty({ minimum: 1, maximum: 365 }) days!: number;
}

export class ProviderQualityMetricsDto {
  @ApiProperty({ minimum: 1 }) attempts!: number;
  @ApiProperty({ minimum: 0 }) successes!: number;
  @ApiProperty({ minimum: 0 }) zeroResults!: number;
  @ApiProperty({ minimum: 0 }) failures!: number;
  @ApiProperty({ minimum: 0 }) processed!: number;
  @ApiProperty({ minimum: 0 }) raw!: number;
  @ApiProperty({ nullable: true, minimum: 0 }) accepted!: number | null;
  @ApiProperty({ nullable: true, minimum: 0 }) bound!: number | null;
  @ApiProperty({ nullable: true, minimum: 0 }) domain!: number | null;
  @ApiProperty({ nullable: true, minimum: 0 }) authority!: number | null;
  @ApiProperty({ nullable: true, minimum: 0 }) conflicts!: number | null;
  @ApiProperty({ minimum: 0 }) duplicates!: number;
}

export class ProviderQualityRatesDto {
  @ApiProperty({ nullable: true, minimum: 0, maximum: 1 }) bound!: number | null;
  @ApiProperty({ nullable: true, minimum: 0, maximum: 1 }) domain!: number | null;
  @ApiProperty({ nullable: true, minimum: 0, maximum: 1 }) authority!: number | null;
  @ApiProperty({ nullable: true, minimum: 0, maximum: 1 }) conflict!: number | null;
  @ApiProperty({ nullable: true, minimum: 0, maximum: 1 }) failure!: number | null;
  @ApiProperty({ nullable: true, minimum: 0, maximum: 1 }) duplicate!: number | null;
}

export class ProviderQualityRankingRowDto {
  @ApiProperty({ maxLength: 128 }) providerKey!: string;
  @ApiProperty({ minimum: 1, description: '所选时间窗中实际尝试过该渠道的 DiscoveryRun 数' }) attemptedRuns!: number;
  @ApiProperty({ minimum: 0, description: '其中至少一次 Provider 调用失败的运行数' }) failedRuns!: number;
  @ApiProperty({ minimum: 1, deprecated: true, description: 'attemptedRuns 的兼容别名' }) runCount!: number;
  @ApiProperty() sampleSufficient!: boolean;
  @ApiProperty({ nullable: true, minimum: 1 }) rank!: number | null;
  @ApiProperty({ enum: PROVIDER_QUALITY_METRICS }) selectedMetric!: ProviderQualityMetric;
  @ApiProperty({ nullable: true, minimum: 0, maximum: 1 }) selectedValue!: number | null;
  @ApiProperty({ type: ProviderQualityMetricsDto }) metrics!: ProviderQualityMetricsDto;
  @ApiProperty({ type: ProviderQualityRatesDto }) rates!: ProviderQualityRatesDto;
  @ApiProperty({ type: [String] }) warnings!: string[];
}

export class ProviderQualityRankingDto {
  @ApiProperty({ type: ProviderQualityWindowDto }) window!: ProviderQualityWindowDto;
  @ApiProperty({ minimum: 1, maximum: 100 }) minimumRunCount!: number;
  @ApiProperty({ enum: PROVIDER_QUALITY_METRICS }) rankingMetric!: ProviderQualityMetric;
  @ApiProperty() interpretation!: string;
  @ApiProperty({ type: [ProviderQualityRankingRowDto] }) providers!: ProviderQualityRankingRowDto[];
}
