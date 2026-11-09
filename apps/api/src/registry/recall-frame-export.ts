/**
 * 召回审计的 frame 导出（ch03 §3.17.5 T3-20 的离线骨架）。
 *
 * 审计的第一段是「冻结 frame → 可复算的抽样输入」：给定一个 registry frame 的
 * 快照，导出该快照里的全部实体（审计口径的分母），带 content hash 与导出时间，
 * 输出格式即 `recall-audit.mjs --frame` 接受的输入（`{entities: [...]}` 超集）。
 *
 * 语义边界：
 *  - 「该快照里的实体」= `registry_entity.last_snapshot_id = snapshot.id`（快照冻结集合，
 *    与查询层的「active snapshot」口径同源）；
 *  - 导出只做选择与规范化排序，不做抽样——抽样由 recall-audit CLI 的固定 seed 完成，
 *    seed 与导出 sha256 一起构成报告的可复算指纹；
 *  - 产物侧（run 产出池）导出等执行面（local_query 血缘获批）后接线，本模块不预造。
 */
import { createHash } from 'node:crypto';

export const RECALL_FRAME_EXPORT_SCHEMA = 'recall-frame-export/v1';

export interface RecallFrameExportRow {
  scheme: string;
  regNumber: string;
  country: string;
  name: string;
  nace: string | null;
  employeeBand: string | null;
}

export interface RecallFrameExportManifest {
  frameKey: string;
  snapshotId: string;
  /** 导出实体集的规范哈希（排序后逐行 JSON 的 sha256）。 */
  sha256: string;
  rowCount: number;
  exportedAt: string;
}

export interface RecallFrameExport {
  schemaVersion: typeof RECALL_FRAME_EXPORT_SCHEMA;
  manifest: RecallFrameExportManifest;
  entities: RecallFrameExportRow[];
}

export class RecallFrameExportError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RecallFrameExportError';
    this.code = code;
  }
}

function rowKey(row: RecallFrameExportRow): string {
  return `${row.scheme}\u0001${row.regNumber}`;
}

function canonicalRow(row: RecallFrameExportRow): string {
  return JSON.stringify([
    row.scheme,
    row.regNumber,
    row.country,
    row.name,
    row.nace ?? null,
    row.employeeBand ?? null,
  ]);
}

/** 排序 + 规范哈希 + 行级最小校验；输入乱序不影响导出（确定性）。 */
export function buildRecallFrameExport(input: {
  frameKey: string;
  snapshotId: string;
  rows: readonly RecallFrameExportRow[];
  exportedAt: string;
}): RecallFrameExport {
  if (!input.frameKey.trim() || !input.snapshotId.trim()) {
    throw new RecallFrameExportError('RECALL_EXPORT_MANIFEST_INVALID', 'frameKey/snapshotId 不能为空');
  }
  const seen = new Set<string>();
  const entities = [...input.rows].map((row) => ({
    scheme: row.scheme.trim(),
    regNumber: row.regNumber.trim(),
    country: row.country.trim().toUpperCase(),
    name: row.name.trim(),
    nace: row.nace,
    employeeBand: row.employeeBand,
  }));
  for (const row of entities) {
    if (!row.scheme || !row.regNumber || !row.country || !row.name) {
      throw new RecallFrameExportError(
        'RECALL_EXPORT_ROW_INVALID',
        `实体行缺必填字段：${JSON.stringify(row)}`,
      );
    }
    const key = rowKey(row);
    if (seen.has(key)) {
      throw new RecallFrameExportError('RECALL_EXPORT_DUPLICATE_KEY', `重复业务键：${row.scheme}:${row.regNumber}`);
    }
    seen.add(key);
  }
  entities.sort((left, right) => rowKey(left).localeCompare(rowKey(right)));
  const sha256 = createHash('sha256')
    .update(entities.map(canonicalRow).join('\n'), 'utf8')
    .digest('hex');
  return {
    schemaVersion: RECALL_FRAME_EXPORT_SCHEMA,
    manifest: {
      frameKey: input.frameKey,
      snapshotId: input.snapshotId,
      sha256,
      rowCount: entities.length,
      exportedAt: input.exportedAt,
    },
    entities,
  };
}
