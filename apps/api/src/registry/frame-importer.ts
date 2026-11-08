/**
 * Frame 装载编排（v0）：校验和 → 快照幂等 → 解析 → 逐行归一 → 装载计划 → 事务应用。
 *
 * 幂等三重保证：
 *  1. 同一文件（sha256 相同）且快照已 PARSED → 直接返回既有快照，不产生任何写入；
 *  2. 实体按 (scheme, regNumber) upsert，事件按 (scheme, regNumber, snapshotId, changeType)
 *     唯一键跳过，崩溃重试安全；
 *  3. contentHash 未变的既有实体只触碰 lastSeenAt，不产生变更事件。
 */
import { createHash } from 'node:crypto';
import { FrameConfigError, parseFrameConfig, type FrameConfig } from './frame-types';
import { parseCsv, parseJsonRecords, readDottedPath } from './frame-parse';
import {
  csvFieldReader,
  jsonFieldReader,
  normalizeRecord,
  type NormalizedRegistryEntity,
  type RowIssue,
} from './frame-normalize';
import { FrameLoadError, planFrameLoad } from './frame-loader';
import type { RegistryFrameStore, SnapshotRow } from './frame-store';
import { proposeEntityLinks, type EntityLinkProposal } from './merge';

export const REGISTRY_FRAMES_PARSER_VERSION = 'registry-frames-v0';

const MAX_MANIFEST_ISSUES = 100;

export class FrameImportError extends Error {
  readonly code: string;
  readonly issues: Array<RowIssue | { code: string; detail: string }>;
  constructor(
    message: string,
    code: string,
    issues: Array<RowIssue | { code: string; detail: string }> = [],
  ) {
    super(message);
    this.name = 'FrameImportError';
    this.code = code;
    this.issues = issues;
  }
}

export interface ImportFrameInput {
  store: RegistryFrameStore;
  config: unknown;
  file: { name: string; bytes: Buffer };
  now?: Date;
  /** true：跳过行级校验失败的行（计数入 manifest）；false（默认）：任一行失败即整批失败。 */
  allowPartial?: boolean;
  /** true：装载后对全库实体跑硬键 + 名称 trigram 链接提案。 */
  proposeLinks?: boolean;
  parserVersion?: string;
}

export interface ImportFrameResult {
  frameKey: string;
  snapshotId: string;
  idempotent: boolean;
  stats: {
    parsedRows: number;
    added: number;
    updated: number;
    unchanged: number;
    missing: number;
    withdrawn: number;
    reappeared: number;
    invalidRows: number;
  };
  warnings: RowIssue[];
  linkProposals?: { hardKey: number; nameTrigram: number; inserted: number };
}

interface ParsedFrameRow {
  rowNumber: number;
  reader: ReturnType<typeof csvFieldReader>;
}

function checksum(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertColumnsPresent(
  config: FrameConfig,
  header: string[],
): void {
  const available = new Set(header);
  const pointers = new Set<string>();
  const fields = config.mapping.fields;
  const singles = [
    fields.regNumber,
    fields.name,
    fields.country,
    fields.status,
    fields.legalForm,
    fields.city,
    fields.region,
    fields.postalCode,
    fields.nace,
    fields.naceVersion,
    fields.employeeBand,
    fields.vatId,
    fields.lei,
    fields.website,
  ];
  for (const pointer of singles) {
    if (pointer) pointers.add(pointer);
  }
  for (const pointer of fields.addressLines ?? []) pointers.add(pointer);
  for (const entry of fields.identifiers ?? []) pointers.add(entry.value);
  const missing = [...pointers].filter((pointer) => !available.has(pointer));
  if (missing.length > 0) {
    throw new FrameImportError(
      `CSV 缺少映射列（${missing.length} 个）`,
      'FRAME_MISSING_COLUMNS',
      missing.map((pointer) => ({ code: 'MISSING_COLUMN', detail: pointer })),
    );
  }
}

function readRows(config: FrameConfig, text: string): ParsedFrameRow[] {
  const mapping = config.mapping;
  if (mapping.format === 'csv') {
    const { header, records } = parseCsv(text, { delimiter: mapping.csv?.delimiter ?? ',' });
    assertColumnsPresent(config, header);
    return records.map((record) => ({
      rowNumber: record.line,
      reader: csvFieldReader(header, record.values),
    }));
  }
  const records = parseJsonRecords(text, mapping.recordsPath ?? '');
  return records.map((record) => ({
    rowNumber: record.rowNumber,
    reader: jsonFieldReader(record.value, readDottedPath),
  }));
}

export interface FrameFileContents {
  rowCount: number;
  entities: NormalizedRegistryEntity[];
  warnings: RowIssue[];
  invalid: RowIssue[];
}

/** 解析 + 逐行归一（无 DB）。供装载与离线 `--dry-run` 预览共用。 */
export function readFrameFile(config: FrameConfig, bytes: Buffer): FrameFileContents {
  const rows = readRows(config, bytes.toString('utf8'));
  const warnings: RowIssue[] = [];
  const invalid: RowIssue[] = [];
  const entities: NormalizedRegistryEntity[] = [];
  for (const row of rows) {
    const normalized = normalizeRecord({ mapping: config.mapping, row: row.rowNumber, read: row.reader });
    if (!normalized.ok) {
      invalid.push(...normalized.issues);
      continue;
    }
    warnings.push(...normalized.warnings);
    entities.push(normalized.entity);
  }
  return { rowCount: rows.length, entities, warnings, invalid };
}

export async function importFrame(input: ImportFrameInput): Promise<ImportFrameResult> {
  const now = input.now ?? new Date();
  const parserVersion = input.parserVersion ?? REGISTRY_FRAMES_PARSER_VERSION;

  let config: FrameConfig;
  try {
    config = parseFrameConfig(input.config);
  } catch (error) {
    if (error instanceof FrameConfigError) {
      throw new FrameImportError(
        error.message,
        'FRAME_CONFIG_INVALID',
        error.issues.map((detail) => ({ code: 'FRAME_CONFIG_INVALID', detail })),
      );
    }
    throw error;
  }

  const sha256 = checksum(input.file.bytes);
  const frame = await input.store.getOrCreateFrame(config.frame);
  if (frame.status !== 'ACTIVE') {
    // Kill switch：PAUSED/ARCHIVED 的帧不再刷新（ch03 §3.24 单源回退）。
    throw new FrameImportError(
      `frame ${frame.frameKey} 状态为 ${frame.status}，拒绝装载（先恢复 ACTIVE）`,
      'FRAME_NOT_ACTIVE',
    );
  }

  const existingSnapshot = await input.store.findSnapshotByChecksum(frame.id, sha256);
  if (existingSnapshot?.status === 'PARSED') {
    const manifest = existingSnapshot.manifest as {
      counts?: Record<string, number>;
      parserVersion?: string;
    } | null;
    if (manifest?.parserVersion === parserVersion) {
      return {
        frameKey: frame.frameKey,
        snapshotId: existingSnapshot.id,
        idempotent: true,
        stats: {
          parsedRows: manifest.counts?.parsedRows ?? Number(existingSnapshot.rowCount),
          added: manifest.counts?.added ?? 0,
          updated: manifest.counts?.updated ?? 0,
          unchanged: manifest.counts?.unchanged ?? 0,
          missing: manifest.counts?.missing ?? 0,
          withdrawn: manifest.counts?.withdrawn ?? 0,
          reappeared: manifest.counts?.reappeared ?? 0,
          invalidRows: manifest.counts?.invalidRows ?? 0,
        },
        warnings: [],
      };
    }
    // 映射/解析器升级（parserVersion 变化）后同一字节文件需要重算：复用快照行继续执行，
    // 而不是静默当作幂等命中。快照唯一键是 (frame_id, sha256)，无法为同文件再造一行。
  }

  const snapshot: SnapshotRow =
    existingSnapshot ??
    (await input.store.createSnapshot({
      frameId: frame.id,
      objectKey: input.file.name,
      sha256,
      bytes: BigInt(input.file.bytes.length),
      rowCount: 0n,
      parserVersion,
      fetchedAt: now,
    }));

  const failSnapshot = async (code: string): Promise<void> => {
    await input.store.finishSnapshot(snapshot.id, { status: 'FAILED', errorCode: code });
  };

  let contents: FrameFileContents;
  try {
    contents = readFrameFile(config, input.file.bytes);
  } catch (error) {
    await failSnapshot('FRAME_PARSE_FAILED');
    throw error;
  }
  const { entities, warnings, invalid } = contents;
  if (invalid.length > 0 && !input.allowPartial) {
    await failSnapshot('FRAME_INVALID_ROWS');
    throw new FrameImportError(
      `行级校验失败 ${invalid.length} 处（allowPartial 未开启）`,
      'FRAME_INVALID_ROWS',
      invalid.slice(0, MAX_MANIFEST_ISSUES),
    );
  }

  const existing = await input.store.loadEntitiesByScheme(config.mapping.constants.scheme);

  let plan: ReturnType<typeof planFrameLoad>;
  try {
    plan = planFrameLoad({ records: entities, existing, now });
  } catch (error) {
    if (error instanceof FrameLoadError) {
      await failSnapshot(error.code);
      throw new FrameImportError(
        error.message,
        error.code,
        error.details.map((detail) => ({ code: error.code, detail })),
      );
    }
    throw error;
  }

  await input.store.applyPlan(plan, { snapshotId: snapshot.id, frameId: frame.id, now });
  await input.store.finishSnapshot(snapshot.id, {
    status: 'PARSED',
    rowCount: BigInt(entities.length),
    publishedAt: now,
    manifest: {
      frameKey: frame.frameKey,
      parserVersion,
      format: config.mapping.format,
      fetchedAt: now.toISOString(),
      counts: {
        parsedRows: contents.rowCount,
        validRows: entities.length,
        invalidRows: invalid.length,
        ...plan.stats,
      },
      warnings: warnings.slice(0, MAX_MANIFEST_ISSUES),
      licenceSnapshot: {
        licence: config.frame.licence,
        licenceUrl: config.frame.licenceUrl ?? null,
        sourceUrl: config.frame.sourceUrl,
      },
    },
  });
  await input.store.supersedeSnapshots(frame.id, snapshot.id);

  let linkProposals: ImportFrameResult['linkProposals'];
  if (input.proposeLinks) {
    const all = await input.store.loadAllEntities();
    const proposals: EntityLinkProposal[] = proposeEntityLinks(all);
    const { inserted } = await input.store.upsertEntityLinks(proposals);
    linkProposals = {
      hardKey: proposals.filter((p) => p.rule !== 'name_trigram').length,
      nameTrigram: proposals.filter((p) => p.rule === 'name_trigram').length,
      inserted,
    };
  }

  return {
    frameKey: frame.frameKey,
    snapshotId: snapshot.id,
    idempotent: false,
    stats: {
      parsedRows: contents.rowCount,
      invalidRows: invalid.length,
      ...plan.stats,
    },
    warnings: warnings.slice(0, MAX_MANIFEST_ISSUES),
    linkProposals,
  };
}
