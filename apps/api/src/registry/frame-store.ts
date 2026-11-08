/**
 * Frame 装载的存储契约（v0）。实现方：
 *  - `PrismaRegistryFrameStore`（owner 连接；平台级任务，见 frame-store.prisma.ts）；
 *  - 单测用内存实现（frame-store.test-fixture.ts）。
 *
 * 平台表（registry_frame/snapshot/entity/change/link）无 RLS：写入只允许平台 ops
 * （owner 连接），app_user 仅 SELECT。
 */
import type { FrameDefinitionInput } from './frame-types';
import type { ExistingRegistryEntity, FrameLoadPlan } from './frame-loader';
import type { EntityLinkProposal } from './merge';

export interface FrameRow {
  id: string;
  frameKey: string;
  country: string;
  scheme: string;
  status: string;
}

export interface SnapshotRow {
  id: string;
  frameId: string;
  sha256: string;
  status: string;
  rowCount: bigint;
  manifest: unknown;
}

export interface CreateSnapshotInput {
  frameId: string;
  objectKey: string;
  sha256: string;
  bytes: bigint;
  rowCount: bigint;
  parserVersion: string;
  fetchedAt: Date;
}

export interface FinishSnapshotInput {
  status: 'PARSED' | 'FAILED';
  rowCount?: bigint;
  manifest?: unknown;
  errorCode?: string;
  publishedAt?: Date;
}

export interface RegistryFrameStore {
  getOrCreateFrame(definition: FrameDefinitionInput): Promise<FrameRow>;
  findSnapshotByChecksum(frameId: string, sha256: string): Promise<SnapshotRow | null>;
  createSnapshot(input: CreateSnapshotInput): Promise<SnapshotRow>;
  finishSnapshot(snapshotId: string, input: FinishSnapshotInput): Promise<void>;
  /** 把该帧其余 PARSED 快照置 SUPERSEDED（保留 keepSnapshotId）。 */
  supersedeSnapshots(frameId: string, keepSnapshotId: string): Promise<void>;
  loadEntitiesByScheme(scheme: string): Promise<ExistingRegistryEntity[]>;
  loadAllEntities(options?: { limit?: number }): Promise<ExistingRegistryEntity[]>;
  /** 单事务应用装载计划（实体变更 + append-only 事件；重放幂等）。 */
  applyPlan(
    plan: FrameLoadPlan,
    context: { snapshotId: string; frameId: string; now: Date },
  ): Promise<void>;
  /** 幂等写入实体链接提案（唯一键冲突即跳过）。 */
  upsertEntityLinks(links: EntityLinkProposal[]): Promise<{ inserted: number }>;
}
