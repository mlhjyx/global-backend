/**
 * 金标回流与晋升（P3 J18；设计 §4.3.8.3）。
 *
 * `judgment_golden_label` 是 append-only：晋升/退役都不改写原行，而是**追加**一条
 * 目标 split 的新行（calib/test/retired）。这样「某例何时从 candidate 晋升、何时退役」
 * 全部可追溯，且 replay 幂等（同内容同 split 只允许一行，由 dedupe key 去重）。
 *
 * 生命周期：复核/双标结论 → `candidate` →（质量负责人批量评审）→ `calib` 或 `test`
 * →（季度轮换）→ `retired`（保留在库，不再进评测）。
 */

import type { PrismaClient } from '@prisma/client';

import { RUBRIC_VERSION } from './fit-rubric';

export const GOLDEN_LABEL_SPLITS = [
  'calib',
  'test',
  'candidate',
  'retired',
] as const;
export type GoldenLabelSplit = (typeof GOLDEN_LABEL_SPLITS)[number];

export const GOLDEN_LABEL_SOURCES = [
  'double_annotated',
  'adjudicated',
  'review',
  'external',
] as const;
export type GoldenLabelSource = (typeof GOLDEN_LABEL_SOURCES)[number];

export const GOLDEN_LABELS = ['FIT', 'NOT_FIT', 'UNKNOWN'] as const;
export type GoldenLabel = (typeof GOLDEN_LABELS)[number];

export class GoldenLabelError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'GoldenLabelError';
  }
}

export interface GoldenLabelRow {
  canonicalCompanyId: string;
  icpId: string;
  id: string;
  inputDigest: string;
  label: string;
  labeledAt: Date;
  rubricVersion: string;
  split: string;
  workspaceId: string;
}

/** 同一内容在同一 split 里只允许一行（晋升/退役都依赖它做幂等）。 */
export function promotionDedupeKey(row: {
  canonicalCompanyId: string;
  icpId: string;
  inputDigest: string;
  label: string;
  rubricVersion: string;
  split: string;
  workspaceId: string;
}): string {
  return [
    row.workspaceId,
    row.canonicalCompanyId,
    row.icpId,
    row.inputDigest,
    row.rubricVersion,
    row.label,
    row.split,
  ].join('|');
}

export interface PlanPromotionOptions {
  ids?: readonly string[];
  limit?: number;
  to: Exclude<GoldenLabelSplit, 'candidate'>;
}

export interface PromotionPlan {
  selected: GoldenLabelRow[];
  skipped: Array<{ id: string; reason: 'already-in-target' | 'limit-reached' | 'not-requested' }>;
}

/**
 * 规划 candidate → calib/test 的晋升：按 labeledAt 升序取最早的一批，
 * 已在目标 split 出现的跳过（幂等），可选 --ids 白名单。
 */
export function planPromotion(
  candidates: readonly GoldenLabelRow[],
  existingTargetKeys: ReadonlySet<string>,
  options: PlanPromotionOptions,
): PromotionPlan {
  if ((options.to as string) === 'candidate') {
    throw new GoldenLabelError('GOLDEN_PROMOTION_TARGET_INVALID', 'target split must be calib|test|retired');
  }
  const limit = Math.max(options.limit ?? 50, 1);
  const requested = options.ids ? new Set(options.ids) : null;
  const selected: GoldenLabelRow[] = [];
  const skipped: PromotionPlan['skipped'] = [];
  const ordered = [...candidates].sort(
    (a, b) => a.labeledAt.getTime() - b.labeledAt.getTime() || a.id.localeCompare(b.id),
  );
  for (const row of ordered) {
    if (row.split !== 'candidate') {
      skipped.push({ id: row.id, reason: 'not-requested' });
      continue;
    }
    if (requested && !requested.has(row.id)) {
      skipped.push({ id: row.id, reason: 'not-requested' });
      continue;
    }
    if (selected.length >= limit) {
      skipped.push({ id: row.id, reason: 'limit-reached' });
      continue;
    }
    const key = promotionDedupeKey({ ...row, split: options.to });
    if (existingTargetKeys.has(key)) {
      skipped.push({ id: row.id, reason: 'already-in-target' });
      continue;
    }
    selected.push(row);
  }
  return { selected, skipped };
}

export interface PlanRetirementOptions {
  keep: number;
  split: Exclude<GoldenLabelSplit, 'candidate' | 'retired'>;
}

export interface RetirementPlan {
  retire: GoldenLabelRow[];
  keep: GoldenLabelRow[];
}

/**
 * 季度轮换：保留该 split 内最新的 `keep` 行，其余追加一条 split='retired' 的副本。
 * 同一行已退役过（存在 retired 副本）时计划会重算——调用方以 dedupe key 保证幂等。
 */
export function planRetirement(
  rows: readonly GoldenLabelRow[],
  options: PlanRetirementOptions,
): RetirementPlan {
  const keep = Math.max(options.keep, 0);
  const ordered = [...rows].sort(
    (a, b) => b.labeledAt.getTime() - a.labeledAt.getTime() || a.id.localeCompare(b.id),
  );
  return { keep: ordered.slice(0, keep), retire: ordered.slice(keep) };
}

export interface PromoteGoldenLabelsOptions {
  dryRun?: boolean;
  ids?: readonly string[];
  limit?: number;
  to: Exclude<GoldenLabelSplit, 'candidate'>;
  workspaceId: string;
}

export interface PromoteGoldenLabelsResult {
  dryRun: boolean;
  promoted: number;
  promotedIds: string[];
  skipped: PromotionPlan['skipped'];
  to: string;
}

/** candidate → calib/test/retired：追加目标 split 新行（幂等；dry-run 不写库）。 */
export async function promoteGoldenLabels(
  prisma: PrismaClient,
  options: PromoteGoldenLabelsOptions,
): Promise<PromoteGoldenLabelsResult> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${options.workspaceId}, true)`;
    const candidates = (await tx.judgmentGoldenLabel.findMany({
      where: {
        workspaceId: options.workspaceId,
        split: 'candidate',
        ...(options.ids ? { id: { in: [...options.ids] } } : {}),
      },
      orderBy: { labeledAt: 'asc' },
    })) as unknown as GoldenLabelRow[];
    const targetRows = (await tx.judgmentGoldenLabel.findMany({
      where: { workspaceId: options.workspaceId, split: options.to },
      select: {
        workspaceId: true,
        canonicalCompanyId: true,
        icpId: true,
        inputDigest: true,
        rubricVersion: true,
        label: true,
        split: true,
      },
    })) as unknown as GoldenLabelRow[];
    const existingKeys = new Set(targetRows.map((row) => promotionDedupeKey(row)));
    const plan = planPromotion(candidates, existingKeys, {
      to: options.to,
      limit: options.limit,
      ids: options.ids,
    });
    if (!options.dryRun && plan.selected.length > 0) {
      await tx.judgmentGoldenLabel.createMany({
        data: plan.selected.map((row) => ({
          workspaceId: row.workspaceId,
          canonicalCompanyId: row.canonicalCompanyId,
          icpId: row.icpId,
          label: row.label,
          labelSource: 'adjudicated',
          reviewTaskId: null,
          annotatorHash: null,
          rubricVersion: row.rubricVersion,
          inputDigest: row.inputDigest,
          split: options.to,
        })),
      });
    }
    return {
      dryRun: options.dryRun ?? false,
      to: options.to,
      promoted: plan.selected.length,
      promotedIds: plan.selected.map((row) => row.id),
      skipped: plan.skipped,
    };
  });
}

export interface RetireGoldenLabelsOptions {
  dryRun?: boolean;
  keep: number;
  split: Exclude<GoldenLabelSplit, 'candidate' | 'retired'>;
  workspaceId: string;
}

export interface RetireGoldenLabelsResult {
  dryRun: boolean;
  kept: number;
  retired: number;
  retiredIds: string[];
}

/** 季度轮换：保留最新 `keep` 行，其余追加 retired 副本（append-only）。 */
export async function retireGoldenLabels(
  prisma: PrismaClient,
  options: RetireGoldenLabelsOptions,
): Promise<RetireGoldenLabelsResult> {
  if ((options.split as string) === 'retired') {
    throw new GoldenLabelError('GOLDEN_RETIREMENT_SPLIT_INVALID', 'cannot retire retired rows');
  }
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${options.workspaceId}, true)`;
    const rows = (await tx.judgmentGoldenLabel.findMany({
      where: { workspaceId: options.workspaceId, split: options.split },
      orderBy: { labeledAt: 'desc' },
    })) as unknown as GoldenLabelRow[];
    const retiredExisting = (await tx.judgmentGoldenLabel.findMany({
      where: { workspaceId: options.workspaceId, split: 'retired' },
      select: {
        workspaceId: true,
        canonicalCompanyId: true,
        icpId: true,
        inputDigest: true,
        rubricVersion: true,
        label: true,
        split: true,
      },
    })) as unknown as GoldenLabelRow[];
    const retiredKeys = new Set(retiredExisting.map((row) => promotionDedupeKey(row)));
    const plan = planRetirement(rows, { split: options.split, keep: options.keep });
    const toRetire = plan.retire.filter(
      (row) => !retiredKeys.has(promotionDedupeKey({ ...row, split: 'retired' })),
    );
    if (!options.dryRun && toRetire.length > 0) {
      await tx.judgmentGoldenLabel.createMany({
        data: toRetire.map((row) => ({
          workspaceId: row.workspaceId,
          canonicalCompanyId: row.canonicalCompanyId,
          icpId: row.icpId,
          label: row.label,
          labelSource: 'adjudicated',
          reviewTaskId: null,
          annotatorHash: null,
          rubricVersion: row.rubricVersion,
          inputDigest: row.inputDigest,
          split: 'retired' as const,
        })),
      });
    }
    return {
      dryRun: options.dryRun ?? false,
      kept: plan.keep.length,
      retired: toRetire.length,
      retiredIds: toRetire.map((row) => row.id),
    };
  });
}

export interface GoldenLabelSummaryRow {
  count: number;
  label: string;
  split: string;
}

/** 金标分布（只读；供周报把「calib/test 是否够用」讲清楚）。 */
export async function goldenLabelSummary(
  prisma: PrismaClient,
  workspaceId: string,
): Promise<GoldenLabelSummaryRow[]> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`;
    const grouped = await tx.judgmentGoldenLabel.groupBy({
      by: ['split', 'label'],
      where: { workspaceId },
      _count: { _all: true },
    });
    return grouped.map((row) => ({
      split: String(row.split),
      label: String(row.label),
      count: Number((row._count as { _all?: number })?._all ?? 0),
    }));
  });
}

/** 当前 rubric 版本（晋升脚本默认只处理与当前 rubric 匹配的样本）。 */
export const GOLDEN_LABEL_RUBRIC_VERSION = RUBRIC_VERSION;

