/**
 * 快照装载计划（v0）：给定「本次快照的归一记录」与「库内既有实体」，纯函数算出
 * 需要执行的新增/更新/触碰/缺席/退出/重现操作与 append-only 变更事件。
 *
 * 规则（对齐 ch03 §3.9.9）：
 *  - 业务键 (scheme, regNumber)；文件内重复业务键 → 整批失败（数据损坏，不猜）。
 *  - contentHash 相同 → UNCHANGED（只触碰 lastSeenAt）；不同 → UPDATED + fieldDiffs（≤20）。
 *  - 本快照缺席：missCount+1；连续 2 个快照缺席（missCount ≥2）才 WITHDRAWN，防单次缺失误杀。
 *  - 已退出实体重现 → REAPPEARED，清 withdrawnAt、missCount=0。
 *  - 事件唯一键 (scheme, regNumber, snapshotId, changeType)：重放同一快照不产生重复事件。
 */
import type { NormalizedRegistryEntity } from './frame-normalize';

export type RegistryChangeType = 'ADDED' | 'UPDATED' | 'WITHDRAWN' | 'REAPPEARED';

export interface ExistingRegistryEntity extends NormalizedRegistryEntity {
  id: string;
  missCount: number;
  withdrawnAt: Date | null;
}

export interface FieldDiff {
  field: string;
  before: string | null;
  after: string | null;
}

export interface RegistryChangeRow {
  scheme: string;
  regNumber: string;
  changeType: RegistryChangeType;
  fieldDiffs: FieldDiff[] | null;
  contentHash: string;
}

export interface FrameLoadPlan {
  adds: NormalizedRegistryEntity[];
  updates: Array<{
    id: string;
    entity: NormalizedRegistryEntity;
    /** 装载时的 contentHash（存储层乐观锁条件；不匹配说明库在计划与写入之间被改过）。 */
    previousContentHash: string;
    fieldDiffs: FieldDiff[];
  }>;
  touches: string[];
  misses: Array<{ id: string; missCount: number }>;
  withdrawals: Array<{ id: string; missCount: number }>;
  reappeared: Array<{ id: string; entity: NormalizedRegistryEntity }>;
  changes: RegistryChangeRow[];
  stats: {
    added: number;
    updated: number;
    unchanged: number;
    missing: number;
    withdrawn: number;
    reappeared: number;
  };
}

export class FrameLoadError extends Error {
  readonly code: string;
  readonly details: string[];
  constructor(message: string, code: string, details: string[]) {
    super(message);
    this.name = 'FrameLoadError';
    this.code = code;
    this.details = details;
  }
}

const DIFF_FIELDS: ReadonlyArray<keyof NormalizedRegistryEntity> = [
  'country',
  'name',
  'nameNorm',
  'legalForm',
  'status',
  'city',
  'postalCode',
  'region',
  'nace',
  'naceVersion',
  'employeeBand',
  'vatId',
  'lei',
  'website',
];

const MAX_FIELD_DIFFS = 20;

function comparable(field: keyof NormalizedRegistryEntity, entity: NormalizedRegistryEntity): string | null {
  if (field === 'addressJson') {
    return entity.addressJson ? JSON.stringify(entity.addressJson) : null;
  }
  if (field === 'identifiers') {
    return entity.identifiers ? JSON.stringify(entity.identifiers) : null;
  }
  const value = entity[field];
  return value == null ? null : String(value);
}

export function diffEntities(
  before: NormalizedRegistryEntity,
  after: NormalizedRegistryEntity,
): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  const fields: Array<keyof NormalizedRegistryEntity> = [
    ...DIFF_FIELDS,
    'addressJson',
    'identifiers',
  ];
  for (const field of fields) {
    const previous = comparable(field, before);
    const next = comparable(field, after);
    if (previous !== next) {
      diffs.push({ field: String(field), before: previous, after: next });
      if (diffs.length >= MAX_FIELD_DIFFS) break;
    }
  }
  return diffs;
}

export interface PlanFrameLoadInput {
  /** 本快照的全量归一记录（已通过行级校验）。 */
  records: NormalizedRegistryEntity[];
  /** 库内既有实体（按 scheme 过滤后可含 withdrawn 行）。 */
  existing: ExistingRegistryEntity[];
  now: Date;
}

export function planFrameLoad(input: PlanFrameLoadInput): FrameLoadPlan {
  const { records, existing } = input;

  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const record of records) {
    const key = `${record.scheme}\u0001${record.regNumber}`;
    if (seen.has(key)) {
      duplicates.push(`${record.scheme}:${record.regNumber}`);
    }
    seen.add(key);
  }
  if (duplicates.length > 0) {
    throw new FrameLoadError(
      `快照内出现重复业务键（${duplicates.length} 个）`,
      'FRAME_DUPLICATE_REG_NUMBER',
      duplicates.slice(0, 20),
    );
  }

  const plan: FrameLoadPlan = {
    adds: [],
    updates: [],
    touches: [],
    misses: [],
    withdrawals: [],
    reappeared: [],
    changes: [],
    stats: { added: 0, updated: 0, unchanged: 0, missing: 0, withdrawn: 0, reappeared: 0 },
  };

  const existingByKey = new Map<string, ExistingRegistryEntity>();
  for (const entity of existing) {
    existingByKey.set(`${entity.scheme}\u0001${entity.regNumber}`, entity);
  }

  const presentKeys = new Set<string>();
  for (const record of records) {
    const key = `${record.scheme}\u0001${record.regNumber}`;
    presentKeys.add(key);
    const current = existingByKey.get(key);
    if (!current) {
      plan.adds.push(record);
      plan.changes.push({
        scheme: record.scheme,
        regNumber: record.regNumber,
        changeType: 'ADDED',
        fieldDiffs: null,
        contentHash: record.contentHash,
      });
      plan.stats.added++;
      continue;
    }
    if (current.withdrawnAt) {
      plan.reappeared.push({ id: current.id, entity: record });
      plan.changes.push({
        scheme: record.scheme,
        regNumber: record.regNumber,
        changeType: 'REAPPEARED',
        fieldDiffs: null,
        contentHash: record.contentHash,
      });
      plan.stats.reappeared++;
      continue;
    }
    if (current.contentHash === record.contentHash) {
      plan.touches.push(current.id);
      plan.stats.unchanged++;
      continue;
    }
    const fieldDiffs = diffEntities(current, record);
    plan.updates.push({ id: current.id, entity: record, previousContentHash: current.contentHash, fieldDiffs });
    plan.changes.push({
      scheme: record.scheme,
      regNumber: record.regNumber,
      changeType: 'UPDATED',
      fieldDiffs,
      contentHash: record.contentHash,
    });
    plan.stats.updated++;
  }

  for (const entity of existing) {
    const key = `${entity.scheme}\u0001${entity.regNumber}`;
    if (presentKeys.has(key)) continue;
    const missCount = entity.missCount + 1;
    if (entity.withdrawnAt) {
      // 已退出且仍缺席：保持退出状态（missCount 继续累计，便于观测）。
      plan.misses.push({ id: entity.id, missCount });
      plan.stats.missing++;
      continue;
    }
    if (missCount >= 2) {
      plan.withdrawals.push({ id: entity.id, missCount });
      plan.changes.push({
        scheme: entity.scheme,
        regNumber: entity.regNumber,
        changeType: 'WITHDRAWN',
        fieldDiffs: null,
        contentHash: entity.contentHash,
      });
      plan.stats.withdrawn++;
      continue;
    }
    plan.misses.push({ id: entity.id, missCount });
    plan.stats.missing++;
  }

  return plan;
}
