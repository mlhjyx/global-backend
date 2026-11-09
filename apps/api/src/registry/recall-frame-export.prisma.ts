/**
 * frame 导出的数据库读取（`buildRecallFrameExport` 的取数层）。
 *
 * registry_* 是平台表（无 RLS，app_user 只读），owner 与 app_user 连接都可用。
 * 语义与 scripts/frames/recall-frame-export.mts 一致：默认取最近一个 PARSED 快照，
 * 导出该快照的冻结实体集合（last_snapshot_id = snapshot.id 且未退出）。
 */
import type { Prisma } from '@prisma/client';
import {
  buildRecallFrameExport,
  RecallFrameExportError,
  type RecallFrameExport,
} from './recall-frame-export';

type FrameSourceClient = Pick<
  Prisma.TransactionClient,
  'registryFrame' | 'registrySnapshot' | 'registryEntity'
>;

export async function loadRecallFrameExport(
  client: FrameSourceClient,
  input: { frameKey: string; snapshotId?: string | null; exportedAt: string },
): Promise<RecallFrameExport> {
  const frame = await client.registryFrame.findUnique({ where: { frameKey: input.frameKey } });
  if (!frame) {
    throw new RecallFrameExportError('FRAME_NOT_FOUND', `frame 不存在：${input.frameKey}`);
  }
  const snapshot = input.snapshotId
    ? await client.registrySnapshot.findUnique({ where: { id: input.snapshotId } })
    : await client.registrySnapshot.findFirst({
        where: { frameId: frame.id, status: 'PARSED' },
        orderBy: { fetchedAt: 'desc' },
      });
  if (!snapshot || snapshot.frameId !== frame.id) {
    throw new RecallFrameExportError(
      'SNAPSHOT_NOT_FOUND',
      `未找到 frame ${frame.frameKey} 的快照${input.snapshotId ? `（${input.snapshotId}）` : ''}`,
    );
  }
  if (snapshot.status !== 'PARSED') {
    throw new RecallFrameExportError(
      'SNAPSHOT_NOT_PARSED',
      `快照 ${snapshot.id} 状态为 ${snapshot.status}，只能导出 PARSED 快照`,
    );
  }
  const rows = await client.registryEntity.findMany({
    where: { lastSnapshotId: snapshot.id, withdrawnAt: null },
    select: {
      scheme: true,
      regNumber: true,
      country: true,
      name: true,
      nace: true,
      employeeBand: true,
    },
    orderBy: [{ scheme: 'asc' }, { regNumber: 'asc' }],
  });
  return buildRecallFrameExport({
    frameKey: frame.frameKey,
    snapshotId: snapshot.id,
    rows,
    exportedAt: input.exportedAt,
  });
}
