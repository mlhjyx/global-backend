/**
 * 召回审计执行面活动（ch03 §3.17.5，批次 3b 骨架；env 门 RECALL_AUDIT_WORKFLOW_ENABLED 默认关）。
 *
 * 三段：导出 frame（平台表只读）→ 导出 run 产出池（租户表走 withWorkspace）→
 * 纯函数 auditRecall（Wilson 95% CI）。workflow 只做编排；报告落盘仍归 CLI
 * （scripts/frames/recall-audit.mjs），本骨架返回 JSON 结果。
 *
 * 载荷护栏：Temporal 默认 2MB blob。frame/pool 超过上限的活动直接拒绝并点名 CLI 路径
 * （大 frame 的全量审计用文件通道，不进 workflow 事件载荷）。
 */
import type { PrismaService } from '../prisma/prisma.service';
import type { Prisma } from '@prisma/client';
import {
  auditRecall,
  type RecallAuditResult,
  type RecallFrameEntity,
  type RecallPoolRecord,
} from '../registry/recall-audit';
import { loadRecallFrameExport } from '../registry/recall-frame-export.prisma';
import type { RecallFrameExport } from '../registry/recall-frame-export';
import {
  buildRecallPoolExport,
  type RecallPoolExport,
} from '../registry/recall-pool-export';
import { loadRunPoolSourceRows } from '../registry/recall-pool-export.prisma';

export class RecallAuditWorkflowError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RecallAuditWorkflowError';
    this.code = code;
  }
}

export const RECALL_AUDIT_DISABLED = 'RECALL_AUDIT_DISABLED';
/** workflow 载荷上限（事件载荷 2MB 与复算成本的折中；更大的审计走 CLI 文件通道）。 */
export const RECALL_AUDIT_MAX_FRAME_ENTITIES = 5_000;
export const RECALL_AUDIT_MAX_POOL_ROWS = 20_000;

export interface RecallAuditActivities {
  exportRecallFrameForAudit(input: { frameKey: string; snapshotId?: string | null }): Promise<RecallFrameExport>;
  exportRecallPoolForAudit(input: { workspaceId: string; runId: string }): Promise<RecallPoolExport>;
  runRecallAuditEstimate(input: {
    frame: RecallFrameEntity[];
    pool: RecallPoolRecord[];
    sampleSize?: number | null;
    seed?: string | null;
  }): Promise<RecallAuditResult>;
}

export interface RecallAuditActivitiesDeps {
  prisma: Pick<PrismaService, 'withWorkspace'> &
    Pick<Prisma.TransactionClient, 'registryFrame' | 'registrySnapshot' | 'registryEntity'>;
  /** 缺省 = `RECALL_AUDIT_WORKFLOW_ENABLED === 'on'`（默认关）。 */
  enabled?: boolean;
  /** 时钟注入（单测固定时间）。 */
  now?: () => string;
}

export function createRecallAuditActivities(deps: RecallAuditActivitiesDeps): RecallAuditActivities {
  const enabled = deps.enabled ?? process.env.RECALL_AUDIT_WORKFLOW_ENABLED === 'on';
  const now = deps.now ?? (() => new Date().toISOString());

  const assertEnabled = (): void => {
    if (!enabled) {
      throw new RecallAuditWorkflowError(
        RECALL_AUDIT_DISABLED,
        'RECALL_AUDIT_WORKFLOW_ENABLED 未开启（默认关）：审计活动拒绝执行',
      );
    }
  };

  return {
    async exportRecallFrameForAudit(input) {
      assertEnabled();
      const exported = await loadRecallFrameExport(deps.prisma, {
        frameKey: input.frameKey,
        snapshotId: input.snapshotId ?? null,
        exportedAt: now(),
      });
      if (exported.manifest.rowCount > RECALL_AUDIT_MAX_FRAME_ENTITIES) {
        throw new RecallAuditWorkflowError(
          'FRAME_TOO_LARGE',
          `frame 冻结实体 ${exported.manifest.rowCount} 行超过 workflow 上限 ${RECALL_AUDIT_MAX_FRAME_ENTITIES}；` +
            '大 frame 请用 scripts/frames/recall-frame-export.mts + recall-audit.mjs 文件通道',
        );
      }
      return exported;
    },

    async exportRecallPoolForAudit(input) {
      assertEnabled();
      const exportedAt = now();
      return deps.prisma.withWorkspace(input.workspaceId, async (tx) => {
        const rows = await loadRunPoolSourceRows(tx, input.workspaceId, input.runId);
        const exported = buildRecallPoolExport({
          rows,
          runId: input.runId,
          workspaceId: input.workspaceId,
          exportedAt,
        });
        if (exported.manifest.rowCount > RECALL_AUDIT_MAX_POOL_ROWS) {
          throw new RecallAuditWorkflowError(
            'POOL_TOO_LARGE',
            `run 产出池 ${exported.manifest.rowCount} 行超过 workflow 上限 ${RECALL_AUDIT_MAX_POOL_ROWS}`,
          );
        }
        return exported;
      });
    },

    async runRecallAuditEstimate(input) {
      assertEnabled();
      if (input.frame.length > RECALL_AUDIT_MAX_FRAME_ENTITIES) {
        throw new RecallAuditWorkflowError('FRAME_TOO_LARGE', 'frame 输入超过 workflow 上限');
      }
      if (input.pool.length > RECALL_AUDIT_MAX_POOL_ROWS) {
        throw new RecallAuditWorkflowError('POOL_TOO_LARGE', 'pool 输入超过 workflow 上限');
      }
      return auditRecall({
        frame: input.frame,
        pool: input.pool,
        sampleSize: input.sampleSize ?? null,
        seed: input.seed ?? null,
      });
    },
  };
}
