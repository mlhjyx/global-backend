import { Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestContext } from '../auth/request-context';

export const PROVIDER_QUALITY_METRICS = ['bound_rate', 'conflict_rate', 'failure_rate', 'duplicate_rate'] as const;
export type ProviderQualityMetric = typeof PROVIDER_QUALITY_METRICS[number];

export type ProviderQualityRankingRequest = {
  windowDays: number;
  minRuns: number;
  metric: ProviderQualityMetric;
};

type MetricField = 'attemptedCount' | 'successCount' | 'zeroResultCount' | 'failureCount' | 'failedRunCount' | 'processedCount' | 'rawCount' | 'acceptedCount' | 'boundCount' | 'domainCount' | 'authorityCount' | 'conflictCount' | 'duplicateCount';

type GroupedQualityRow = {
  providerKey: string;
  _count: { _all: number } & Record<MetricField, number>;
  _sum: Record<MetricField, number | null>;
};

type QualityReader = {
  providerQualityRunContribution: {
    groupBy(args: object): Promise<GroupedQualityRow[]>;
  };
};

type Totals = {
  attempts: number;
  successes: number;
  zeroResults: number;
  failures: number;
  processed: number;
  raw: number;
  accepted: number | null;
  bound: number | null;
  domain: number | null;
  authority: number | null;
  conflicts: number | null;
  duplicates: number;
};

function strictTotal(row: GroupedQualityRow, field: MetricField): number | null {
  return row._count[field] === row._count._all ? (row._sum[field] ?? 0) : null;
}

function ratio(numerator: number | null, denominator: number | null): number | null {
  return numerator === null || denominator === null || denominator <= 0 || numerator > denominator
    ? null
    : numerator / denominator;
}

@Injectable()
export class ProviderQualityService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    private readonly now: () => Date = () => new Date(),
  ) {}

  async rank(ctx: RequestContext, request: ProviderQualityRankingRequest) {
    const to = this.now();
    const from = new Date(to.getTime() - request.windowDays * 24 * 60 * 60 * 1_000);
    const rows = await this.prisma.withWorkspace(ctx.workspaceId, async (rawTx) => {
      const tx = rawTx as unknown as QualityReader;
      return tx.providerQualityRunContribution.groupBy({
        by: ['providerKey'],
        where: { completedAt: { gte: from, lt: to } },
        _count: {
          _all: true,
          attemptedCount: true,
          successCount: true,
          zeroResultCount: true,
          failedRunCount: true,
          processedCount: true,
          rawCount: true,
          acceptedCount: true,
          boundCount: true,
          domainCount: true,
          authorityCount: true,
          conflictCount: true,
          failureCount: true,
          duplicateCount: true,
        },
        _sum: {
          attemptedCount: true,
          successCount: true,
          zeroResultCount: true,
          failedRunCount: true,
          processedCount: true,
          rawCount: true,
          acceptedCount: true,
          boundCount: true,
          domainCount: true,
          authorityCount: true,
          conflictCount: true,
          failureCount: true,
          duplicateCount: true,
        },
        orderBy: { providerKey: 'asc' },
      });
    });

    const providers = rows.map((row) => {
      const metrics: Totals = {
        attempts: strictTotal(row, 'attemptedCount') ?? 0,
        successes: strictTotal(row, 'successCount') ?? 0,
        zeroResults: strictTotal(row, 'zeroResultCount') ?? 0,
        failures: strictTotal(row, 'failureCount') ?? 0,
        processed: strictTotal(row, 'processedCount') ?? 0,
        raw: strictTotal(row, 'rawCount') ?? 0,
        accepted: strictTotal(row, 'acceptedCount'),
        bound: strictTotal(row, 'boundCount'),
        domain: strictTotal(row, 'domainCount'),
        authority: strictTotal(row, 'authorityCount'),
        conflicts: strictTotal(row, 'conflictCount'),
        duplicates: strictTotal(row, 'duplicateCount') ?? 0,
      };
      const attemptedRuns = row._count._all;
      const failedRuns = strictTotal(row, 'failedRunCount') ?? 0;
      const rates = {
        bound: ratio(metrics.bound, metrics.accepted),
        domain: ratio(metrics.domain, metrics.accepted),
        authority: ratio(metrics.authority, metrics.accepted),
        conflict: ratio(metrics.conflicts, metrics.accepted),
        failure: ratio(failedRuns, attemptedRuns),
        duplicate: ratio(metrics.duplicates, metrics.processed),
      };
      const metricKey = request.metric.replace('_rate', '') as keyof typeof rates;
      const sampleSufficient = row._count._all >= request.minRuns;
      const selectedValue = rates[metricKey];
      const warnings: string[] = [];
      if (!sampleSufficient) warnings.push('样本不足，不能据此称为最好渠道');
      if (selectedValue === null) warnings.push('该排名指标存在未知事实，暂不参与排名');
      return {
        providerKey: row.providerKey,
        runCount: attemptedRuns,
        attemptedRuns,
        failedRuns,
        sampleSufficient,
        rank: null as number | null,
        selectedMetric: request.metric,
        selectedValue,
        metrics,
        rates,
        warnings,
      };
    });

    const lowerIsBetter = request.metric !== 'bound_rate';
    providers.sort((left, right) => {
      const leftEligible = left.sampleSufficient && left.selectedValue !== null;
      const rightEligible = right.sampleSufficient && right.selectedValue !== null;
      if (leftEligible !== rightEligible) return leftEligible ? -1 : 1;
      if (leftEligible && rightEligible && left.selectedValue !== right.selectedValue) {
        return lowerIsBetter
          ? (left.selectedValue as number) - (right.selectedValue as number)
          : (right.selectedValue as number) - (left.selectedValue as number);
      }
      return left.providerKey.localeCompare(right.providerKey);
    });
    let rank = 0;
    for (const provider of providers) {
      if (provider.sampleSufficient && provider.selectedValue !== null) provider.rank = ++rank;
    }

    return {
      window: { from: from.toISOString(), to: to.toISOString(), days: request.windowDays },
      minimumRunCount: request.minRuns,
      rankingMetric: request.metric,
      interpretation: '这是按单项可证指标排序的运行账本，不生成综合质量分，也不把小样本渠道称为最好。',
      providers,
    };
  }
}
