/**
 * RegistryFrameStore 的 Prisma 实现（平台 ops 专用，owner 连接）。
 *
 * 平台表无 RLS；app_user 只有 SELECT。写入路径只允许平台级任务（frame 装载脚本 /
 * 后续 T3-03 的 registryFrameSyncWorkflow activities），因此这里要求注入一个以
 * owner DATABASE_URL 构造的 PrismaClient，而不是租户侧 PrismaService。
 */
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import type {
  CreateSnapshotInput,
  FinishSnapshotInput,
  FrameRow,
  RegistryFrameStore,
  SnapshotRow,
} from './frame-store';
import type { ExistingRegistryEntity, FrameLoadPlan } from './frame-loader';
import type { NormalizedRegistryEntity } from './frame-normalize';
import type { FrameDefinitionInput } from './frame-types';
import type { EntityLinkProposal } from './merge';

type JsonInput = Prisma.InputJsonValue | typeof Prisma.DbNull;

function jsonOrNull(value: unknown): JsonInput {
  return value == null ? Prisma.DbNull : (value as Prisma.InputJsonValue);
}

function identifiersOf(value: Prisma.JsonValue | null): Array<{ scheme: string; value: string }> | null {
  if (!Array.isArray(value)) return null;
  const identifiers: Array<{ scheme: string; value: string }> = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.scheme === 'string' && typeof record.value === 'string') {
      identifiers.push({ scheme: record.scheme, value: record.value });
    }
  }
  return identifiers.length > 0 ? identifiers : null;
}

function addressOf(value: Prisma.JsonValue | null): { lines: string[] } | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  const lines = (value as Record<string, unknown>).lines;
  if (!Array.isArray(lines)) return null;
  return { lines: lines.filter((line): line is string => typeof line === 'string') };
}

function entityData(entity: NormalizedRegistryEntity) {
  return {
    scheme: entity.scheme,
    regNumber: entity.regNumber,
    country: entity.country,
    name: entity.name,
    nameNorm: entity.nameNorm,
    legalForm: entity.legalForm,
    status: entity.status,
    addressJson: jsonOrNull(entity.addressJson),
    city: entity.city,
    postalCode: entity.postalCode,
    region: entity.region,
    nace: entity.nace,
    naceVersion: entity.naceVersion,
    employeeBand: entity.employeeBand,
    vatId: entity.vatId,
    lei: entity.lei,
    website: entity.website,
    identifiers: jsonOrNull(entity.identifiers),
    attributes: jsonOrNull(entity.attributes),
    contentHash: entity.contentHash,
  };
}

function stringMapOf(value: Prisma.JsonValue | null): Record<string, string> | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return Object.keys(out).length > 0 ? out : null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toExisting(row: any): ExistingRegistryEntity {
  return {
    id: row.id as string,
    scheme: row.scheme as string,
    regNumber: row.regNumber as string,
    country: row.country as string,
    name: row.name as string,
    nameNorm: row.nameNorm as string,
    legalForm: (row.legalForm as string | null) ?? null,
    status: row.status as NormalizedRegistryEntity['status'],
    addressJson: addressOf(row.addressJson as Prisma.JsonValue | null),
    city: (row.city as string | null) ?? null,
    postalCode: (row.postalCode as string | null) ?? null,
    region: (row.region as string | null) ?? null,
    nace: (row.nace as string | null) ?? null,
    naceVersion: (row.naceVersion as string | null) ?? null,
    employeeBand: (row.employeeBand as NormalizedRegistryEntity['employeeBand']) ?? null,
    vatId: (row.vatId as string | null) ?? null,
    lei: (row.lei as string | null) ?? null,
    website: (row.website as string | null) ?? null,
    identifiers: identifiersOf(row.identifiers as Prisma.JsonValue | null),
    attributes: stringMapOf(row.attributes as Prisma.JsonValue | null),
    contentHash: row.contentHash as string,
    missCount: row.missCount as number,
    withdrawnAt: (row.withdrawnAt as Date | null) ?? null,
  };
}

export class RegistryLoadConflictError extends Error {
  readonly entityId: string;
  constructor(entityId: string) {
    super(`registry_entity ${entityId} 的 contentHash 在计划与写入之间变化（并发写？）`);
    this.name = 'RegistryLoadConflictError';
    this.entityId = entityId;
  }
}

/**
 * 构造平台 ops 用的 owner 连接。放在 apps/api 内是因为 `@prisma/client` 只在该包
 * （与 packages/db）的依赖里；`scripts/` 下的裸脚本解析不到包根，故经此工厂注入。
 */
export function createRegistryFramePrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({ datasourceUrl: databaseUrl });
}

export class PrismaRegistryFrameStore implements RegistryFrameStore {
  constructor(private readonly prisma: PrismaClient) {}

  async getOrCreateFrame(definition: FrameDefinitionInput): Promise<FrameRow> {
    const existing = await this.prisma.registryFrame.findUnique({
      where: { frameKey: definition.frameKey },
    });
    const row =
      existing ??
      (await this.prisma.registryFrame.create({
        data: {
          id: randomUUID(),
          frameKey: definition.frameKey,
          country: definition.country,
          scheme: definition.scheme,
          label: definition.label,
          providerKey: definition.providerKey,
          sourceUrl: definition.sourceUrl,
          licence: definition.licence,
          licenceUrl: definition.licenceUrl ?? null,
          fetchMode: definition.fetchMode,
          cadence: jsonOrNull(definition.cadence),
          config: (definition.config ?? {}) as Prisma.InputJsonValue,
          expectedCount: definition.expectedCount ?? null,
        },
      }));
    return {
      id: row.id,
      frameKey: row.frameKey,
      country: row.country,
      scheme: row.scheme,
      status: row.status,
    };
  }

  async findSnapshotByChecksum(frameId: string, sha256: string): Promise<SnapshotRow | null> {
    const row = await this.prisma.registrySnapshot.findUnique({
      where: { frameId_sha256: { frameId, sha256 } },
    });
    if (!row) return null;
    return {
      id: row.id,
      frameId: row.frameId,
      sha256: row.sha256,
      status: row.status,
      rowCount: row.rowCount,
      manifest: row.manifest,
    };
  }

  async createSnapshot(input: CreateSnapshotInput): Promise<SnapshotRow> {
    const row = await this.prisma.registrySnapshot.create({
      data: {
        id: randomUUID(),
        frameId: input.frameId,
        objectKey: input.objectKey,
        sha256: input.sha256,
        bytes: input.bytes,
        rowCount: input.rowCount,
        parserVersion: input.parserVersion,
        fetchedAt: input.fetchedAt,
      },
    });
    return {
      id: row.id,
      frameId: row.frameId,
      sha256: row.sha256,
      status: row.status,
      rowCount: row.rowCount,
      manifest: row.manifest,
    };
  }

  async finishSnapshot(snapshotId: string, input: FinishSnapshotInput): Promise<void> {
    await this.prisma.registrySnapshot.update({
      where: { id: snapshotId },
      data: {
        status: input.status,
        ...(input.rowCount !== undefined ? { rowCount: input.rowCount } : {}),
        ...(input.manifest !== undefined
          ? { manifest: input.manifest as Prisma.InputJsonValue }
          : {}),
        ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
        ...(input.publishedAt !== undefined ? { publishedAt: input.publishedAt } : {}),
      },
    });
  }

  async supersedeSnapshots(frameId: string, keepSnapshotId: string): Promise<void> {
    await this.prisma.registrySnapshot.updateMany({
      where: { frameId, status: 'PARSED', id: { not: keepSnapshotId } },
      data: { status: 'SUPERSEDED' },
    });
  }

  async loadEntitiesByScheme(scheme: string): Promise<ExistingRegistryEntity[]> {
    const rows = await this.prisma.registryEntity.findMany({ where: { scheme } });
    return rows.map(toExisting);
  }

  async loadAllEntities(options: { limit?: number } = {}): Promise<ExistingRegistryEntity[]> {
    const limit = options.limit ?? 200_000;
    const rows = await this.prisma.registryEntity.findMany({
      take: limit + 1,
      orderBy: [{ scheme: 'asc' }, { regNumber: 'asc' }],
    });
    if (rows.length > limit) {
      // 全库链接提案只覆盖 v0 规模；更大规模走分片/Splink（T3-16），不静默截断。
      throw new Error(
        `registry_entity 超过 ${limit} 行：链接提案需要分片（T3-16 Splink 波次），本次未写入任何链接`,
      );
    }
    return rows.map(toExisting);
  }

  async applyPlan(
    plan: FrameLoadPlan,
    context: { snapshotId: string; frameId: string; now: Date },
  ): Promise<void> {
    const { snapshotId, frameId, now } = context;
    await this.prisma.$transaction(
      async (tx) => {
        for (const entity of plan.adds) {
          await tx.registryEntity.upsert({
            where: {
              scheme_regNumber: { scheme: entity.scheme, regNumber: entity.regNumber },
            },
            create: {
              id: randomUUID(),
              ...entityData(entity),
              sourceFrameId: frameId,
              lastSnapshotId: snapshotId,
              firstSeenAt: now,
              lastSeenAt: now,
            },
            update: {
              ...entityData(entity),
              lastSnapshotId: snapshotId,
              lastSeenAt: now,
              missCount: 0,
              withdrawnAt: null,
            },
          });
        }
        for (const update of plan.updates) {
          const result = await tx.registryEntity.updateMany({
            where: { id: update.id, contentHash: update.previousContentHash },
            data: {
              ...entityData(update.entity),
              lastSnapshotId: snapshotId,
              lastSeenAt: now,
              missCount: 0,
            },
          });
          if (result.count !== 1) {
            throw new RegistryLoadConflictError(update.id);
          }
        }
        for (const reappear of plan.reappeared) {
          const result = await tx.registryEntity.updateMany({
            where: { id: reappear.id },
            data: {
              ...entityData(reappear.entity),
              lastSnapshotId: snapshotId,
              lastSeenAt: now,
              missCount: 0,
              withdrawnAt: null,
            },
          });
          if (result.count !== 1) {
            throw new RegistryLoadConflictError(reappear.id);
          }
        }
        if (plan.touches.length > 0) {
          await tx.registryEntity.updateMany({
            where: { id: { in: plan.touches } },
            data: { lastSeenAt: now, lastSnapshotId: snapshotId, missCount: 0 },
          });
        }
        for (const miss of plan.misses) {
          await tx.registryEntity.updateMany({
            where: { id: miss.id },
            data: { missCount: miss.missCount },
          });
        }
        for (const withdrawal of plan.withdrawals) {
          await tx.registryEntity.updateMany({
            where: { id: withdrawal.id },
            data: { missCount: withdrawal.missCount, withdrawnAt: now },
          });
        }
        if (plan.changes.length > 0) {
          await tx.registryEntityChange.createMany({
            data: plan.changes.map((change) => ({
              id: randomUUID(),
              scheme: change.scheme,
              regNumber: change.regNumber,
              snapshotId,
              changeType: change.changeType,
              fieldDiffs: jsonOrNull(change.fieldDiffs),
              contentHash: change.contentHash,
            })),
            skipDuplicates: true,
          });
        }
      },
      { maxWait: 10_000, timeout: 120_000 },
    );
  }

  async upsertEntityLinks(links: EntityLinkProposal[]): Promise<{ inserted: number }> {
    if (links.length === 0) return { inserted: 0 };
    const result = await this.prisma.registryEntityLink.createMany({
      data: links.map((link) => ({
        id: randomUUID(),
        leftScheme: link.leftScheme,
        leftRegNumber: link.leftRegNumber,
        rightScheme: link.rightScheme,
        rightRegNumber: link.rightRegNumber,
        linkType: link.linkType,
        rule: link.rule,
        score: link.score,
        evidence: jsonOrNull(link.evidence),
        status: link.status,
      })),
      skipDuplicates: true,
    });
    return { inserted: result.count };
  }
}
