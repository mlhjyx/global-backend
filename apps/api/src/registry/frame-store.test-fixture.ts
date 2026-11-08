/**
 * 单测用内存版 RegistryFrameStore：语义与 Prisma 实现一致（业务键 upsert、事件唯一键跳过、
 * 快照状态机），行为可断言。产品构建排除（tsconfig.build 的 **\/*.test-fixture.ts）。
 */
import { randomUUID } from 'node:crypto';
import type {
  CreateSnapshotInput,
  FinishSnapshotInput,
  FrameRow,
  RegistryFrameStore,
  SnapshotRow,
} from './frame-store';
import type { ExistingRegistryEntity, FrameLoadPlan, RegistryChangeRow } from './frame-loader';
import type { NormalizedRegistryEntity } from './frame-normalize';
import type { FrameDefinitionInput } from './frame-types';
import type { EntityLinkProposal } from './merge';

interface StoredEntity extends ExistingRegistryEntity {
  sourceFrameId: string;
  lastSnapshotId: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

function entityKey(scheme: string, regNumber: string): string {
  return `${scheme}\u0001${regNumber}`;
}

function changeKey(change: RegistryChangeRow, snapshotId: string): string {
  return `${change.scheme}\u0001${change.regNumber}\u0001${snapshotId}\u0001${change.changeType}`;
}

function linkKey(link: EntityLinkProposal): string {
  return `${link.leftScheme}\u0001${link.leftRegNumber}\u0001${link.rightScheme}\u0001${link.rightRegNumber}\u0001${link.linkType}`;
}

export class InMemoryRegistryFrameStore implements RegistryFrameStore {
  readonly frames: FrameRow[] = [];
  readonly snapshots: SnapshotRow[] = [];
  readonly entities = new Map<string, StoredEntity>();
  readonly changes = new Map<string, RegistryChangeRow & { snapshotId: string }>();
  readonly links = new Map<string, EntityLinkProposal>();

  constructor(private readonly newId: () => string = () => randomUUID()) {}

  async getOrCreateFrame(definition: FrameDefinitionInput): Promise<FrameRow> {
    const existing = this.frames.find((frame) => frame.frameKey === definition.frameKey);
    if (existing) return existing;
    const frame: FrameRow = {
      id: this.newId(),
      frameKey: definition.frameKey,
      country: definition.country,
      scheme: definition.scheme,
      status: 'ACTIVE',
    };
    this.frames.push(frame);
    return frame;
  }

  async findSnapshotByChecksum(frameId: string, sha256: string): Promise<SnapshotRow | null> {
    return (
      this.snapshots.find((snapshot) => snapshot.frameId === frameId && snapshot.sha256 === sha256) ??
      null
    );
  }

  async createSnapshot(input: CreateSnapshotInput): Promise<SnapshotRow> {
    const snapshot: SnapshotRow = {
      id: this.newId(),
      frameId: input.frameId,
      sha256: input.sha256,
      status: 'FETCHED',
      rowCount: input.rowCount,
      manifest: null,
    };
    this.snapshots.push(snapshot);
    return snapshot;
  }

  async finishSnapshot(snapshotId: string, input: FinishSnapshotInput): Promise<void> {
    const snapshot = this.snapshots.find((item) => item.id === snapshotId);
    if (!snapshot) throw new Error(`unknown snapshot ${snapshotId}`);
    snapshot.status = input.status;
    if (input.rowCount !== undefined) snapshot.rowCount = input.rowCount;
    if (input.manifest !== undefined) snapshot.manifest = input.manifest;
  }

  async supersedeSnapshots(frameId: string, keepSnapshotId: string): Promise<void> {
    for (const snapshot of this.snapshots) {
      if (snapshot.frameId === frameId && snapshot.id !== keepSnapshotId && snapshot.status === 'PARSED') {
        snapshot.status = 'SUPERSEDED';
      }
    }
  }

  async loadEntitiesByScheme(scheme: string): Promise<ExistingRegistryEntity[]> {
    return [...this.entities.values()]
      .filter((entity) => entity.scheme === scheme)
      .map((entity) => ({ ...entity }));
  }

  async loadAllEntities(options: { limit?: number } = {}): Promise<ExistingRegistryEntity[]> {
    const limit = options.limit ?? Number.MAX_SAFE_INTEGER;
    return [...this.entities.values()].slice(0, limit).map((entity) => ({ ...entity }));
  }

  async applyPlan(
    plan: FrameLoadPlan,
    context: { snapshotId: string; frameId: string; now: Date },
  ): Promise<void> {
    const { snapshotId, frameId, now } = context;
    const upsert = (entity: NormalizedRegistryEntity, id: string): void => {
      this.entities.set(entityKey(entity.scheme, entity.regNumber), {
        ...entity,
        id,
        missCount: 0,
        withdrawnAt: null,
        sourceFrameId: frameId,
        lastSnapshotId: snapshotId,
        firstSeenAt: now,
        lastSeenAt: now,
      });
    };
    for (const entity of plan.adds) {
      const key = entityKey(entity.scheme, entity.regNumber);
      const existing = this.entities.get(key);
      // 崩溃重试安全：按业务键 upsert。
      upsert(entity, existing?.id ?? this.newId());
    }
    for (const update of plan.updates) {
      upsert(update.entity, update.id);
    }
    for (const id of plan.touches) {
      for (const entity of this.entities.values()) {
        if (entity.id === id) entity.lastSeenAt = now;
      }
    }
    for (const miss of plan.misses) {
      for (const entity of this.entities.values()) {
        if (entity.id === miss.id) entity.missCount = miss.missCount;
      }
    }
    for (const withdrawal of plan.withdrawals) {
      for (const entity of this.entities.values()) {
        if (entity.id === withdrawal.id) {
          entity.missCount = withdrawal.missCount;
          entity.withdrawnAt = now;
        }
      }
    }
    for (const reappeared of plan.reappeared) {
      upsert(reappeared.entity, reappeared.id);
    }
    for (const change of plan.changes) {
      const key = changeKey(change, snapshotId);
      if (!this.changes.has(key)) {
        this.changes.set(key, { ...change, snapshotId });
      }
    }
  }

  async upsertEntityLinks(links: EntityLinkProposal[]): Promise<{ inserted: number }> {
    let inserted = 0;
    for (const link of links) {
      const key = linkKey(link);
      if (!this.links.has(key)) {
        this.links.set(key, { ...link });
        inserted++;
      }
    }
    return { inserted };
  }
}
