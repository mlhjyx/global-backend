import { createHmac } from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { TemporalClient } from '../temporal/temporal.client';
import {
  DELETION_WORKFLOW,
  DISCOVERY_WORKFLOW,
  QUALIFY_WORKFLOW,
  UNDERSTANDING_TASK_QUEUE,
  UNDERSTANDING_WORKFLOW,
} from '../temporal/understanding.constants';
import { DiscoveryProviderRegistry } from '../discovery/provider.registry';
import { seedSanctions } from '../sanctions/sanctions-seed';
import {
  INTEGRATION_EVENTS,
  INTERNAL_COMMANDS,
  PULL_SINK,
  WEBHOOK_SINK,
  toEnvelope,
} from './event-registry';

/**
 * Transactional Outbox relay (ADR-009). A trusted system scanner: connects as the
 * owner (DATABASE_URL) to read unpublished events ACROSS all tenants — RLS would
 * hide them from app_user. Dispatched work (workflow activities) is tenant-scoped
 * again via withWorkspace. Dev uses simple polling; prod can move to LISTEN/NOTIFY.
 *
 * 收口③：事件按注册表三分支——internal command 拉 Temporal；integration 事件原子路由进
 * outbox_delivery 交付账本（publishedAt 语义 = 「已路由进交付层」，消费真值在账本）；
 * 未注册类型 park（不假发布、不毒化轮询）。webhook sink 在同 tick 内派送（退避 + DLQ + HMAC 签名）。
 *
 * ⚠️ 部署约束（GET /events 游标正确性依赖）：交付账本行必须由**单写者**串行创建——
 * 当前单进程部署 + tick 的 running 互斥满足；若上多 API 副本，各自跑 relay 会重引入
 * 「低事件 id 晚建交付行」的乱序，tick 需先加 pg advisory lock 保证单写者再扩副本。
 */

/** webhook 死信阈值：连续失败达此次数 → DEAD（人工介入）。 */
export const MAX_WEBHOOK_ATTEMPTS = 10;
/** webhook 退避基数：nextAttemptAt = now + min(2^attempts × 30s, 1h)。 */
export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_CAP_MS = 3_600_000;
export const WEBHOOK_TIMEOUT_MS = 10_000;
/** 单 tick 处理上限（路由与派送各自适用），防单轮吃满。 */
const BATCH_SIZE = 20;
/** lastError 截断长度：错误体可能是整页 HTML，不让它撑爆行。 */
const MAX_ERROR_LEN = 500;

/** 路由/派送用到的 outbox_event 行（含 BigInt 主键）。 */
interface OutboxEventRecord {
  id: bigint;
  eventId: string;
  workspaceId: string;
  eventType: string;
  schemaVersion: number;
  aggregateType: string;
  aggregateId: string;
  producer: string;
  correlationId: string | null;
  causationId: string | null;
  privacyClassification: string;
  payload: unknown;
  occurredAt: Date;
  publishedAt: Date | null;
  parkedAt: Date | null;
}

/** fetch 的最小可注入面（单测 mock 用，绝不真发网络）。 */
type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

@Injectable()
export class OutboxRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('OutboxRelay');
  private readonly db: PrismaClient;
  private readonly fetchFn: FetchLike;
  private timer?: NodeJS.Timeout;
  private running = false;
  private expireCounter = 0;

  constructor(
    private readonly temporal: TemporalClient,
    // 可选注入（@Optional：Nest 无 provider 时注入 undefined）→ 单测传 mock db/fetch，生产走默认。
    @Optional() db?: PrismaClient,
    @Optional() fetchFn?: FetchLike,
  ) {
    this.db = db ?? new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
    this.fetchFn = fetchFn ?? ((url, init) => fetch(url, init));
  }

  async onModuleInit(): Promise<void> {
    await this.db.$connect();
    // 平台配置播种（data_provider 无 RLS，owner 连接写入）。失败要**大声**：seed 静默失败意味着
    // 全部 provider 对 registry 路由不可见（信号/富集层运行时 no-op），且环境重置后会无声复发。
    await new DiscoveryProviderRegistry().seed(this.db).catch((err) => {
      this.logger.error(`provider seed FAILED — providers may be invisible to routing (no-op pipeline): ${String(err)}`);
    });
    // 制裁名单源 + source_policy seed（第五门，DISABLED；API-only 部署也需登记 source_policy 供 broker 门）。
    await seedSanctions(this.db).catch((err) => {
      this.logger.error(`sanctions seed FAILED — refresh/screening may be misconfigured: ${String(err)}`);
    });
    // webhook 配置不完整要**大声**：URL 配了但缺 secret / 非 https（非 localhost）→ sink 拒绝启用，
    // 推送通道既不建交付行也不派送——只报一次，不让运维以为推送在跑。
    if (process.env.SAAS_WEBHOOK_URL && !this.webhookEnabled()) {
      this.logger.error(
        'SAAS_WEBHOOK_URL 已配置但 webhook sink 拒绝启用：需同时配 SAAS_WEBHOOK_SECRET 且 URL 为 https://（dev 例外：localhost/127.0.0.1）。当前不建 webhook 交付行、不派送。',
      );
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, 2000);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.db.$disconnect();
  }

  async tick(): Promise<void> {
    if (this.running) return; // avoid overlapping ticks
    this.running = true;
    try {
      await this.expireDueClaims();
      // parked 事件排除在轮询外：未注册类型只报一次错并停靠，不每 2s 重试刷日志。
      const events = (await this.db.outboxEvent.findMany({
        where: { publishedAt: null, parkedAt: null },
        orderBy: { id: 'asc' },
        take: BATCH_SIZE,
      })) as OutboxEventRecord[];
      for (const ev of events) {
        await this.routeEvent(ev);
      }
      // webhook 派送循环：仅推模式启用时才扫账本（与 routeEvent 的 sink 判定共用同一谓词，消除漂移）。
      if (this.webhookEnabled()) {
        await this.pumpWebhookDeliveries(new Date());
      }
    } catch (err) {
      this.logger.error(`relay tick failed: ${String(err)}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * 三分支路由（每事件自吞错误：单事件失败不阻断本批其余事件）。
   * 1. internal command → dispatch Temporal，成功才标 published（行为保持，失败下轮重试）。
   * 2. integration 事件 → **单事务**建交付行 + 标 published；崩溃在两步间 → 重跑 skipDuplicates 幂等。
   * 3. 未注册类型 → parkedAt 停靠 + error 大声（新增事件类型忘记注册是 bug）。
   */
  async routeEvent(ev: OutboxEventRecord): Promise<void> {
    if (INTERNAL_COMMANDS.has(ev.eventType)) {
      try {
        await this.dispatch(ev);
        await this.db.outboxEvent.update({
          where: { id: ev.id },
          data: { publishedAt: new Date() },
        });
      } catch (err) {
        this.logger.error(`dispatch failed for event ${ev.eventId}: ${String(err)}`);
      }
      return;
    }
    if (INTEGRATION_EVENTS.has(ev.eventType)) {
      const sinks = [PULL_SINK, ...(this.webhookEnabled() ? [WEBHOOK_SINK] : [])];
      try {
        await this.db.$transaction(async (tx) => {
          await tx.outboxDelivery.createMany({
            data: sinks.map((sink) => ({ workspaceId: ev.workspaceId, eventId: ev.eventId, sink })),
            skipDuplicates: true,
          });
          await tx.outboxEvent.update({
            where: { id: ev.id },
            data: { publishedAt: new Date() },
          });
        });
      } catch (err) {
        this.logger.error(`delivery routing failed for event ${ev.eventId}: ${String(err)}`);
      }
      return;
    }
    // 未注册类型：停靠（不标 published——那是假发布；不留在轮询里——那是毒化）。
    try {
      await this.db.outboxEvent.update({
        where: { id: ev.id },
        data: { parkedAt: new Date() },
      });
    } catch (err) {
      this.logger.error(`failed to park event ${ev.eventId}: ${String(err)}`);
      return;
    }
    this.logger.error(
      `UNREGISTERED event type '${ev.eventType}' (event ${ev.eventId}) — parked. ` +
        `新增事件类型必须登记 relay/event-registry.ts（internal 或 integration），否则会静默丢失。`,
    );
  }

  /**
   * webhook sink 启用门（G）：URL 已配 && secret 已配 && (https || dev 的 localhost/127.0.0.1)。
   * routeEvent 的 sink 判定与 tick 的 pump 门共用本谓词——消除两处 process.env 漂移；
   * 缺 secret 时绝不发未签名请求（消费端无从验真，等于开伪造口子）。
   */
  private webhookEnabled(): boolean {
    const url = process.env.SAAS_WEBHOOK_URL;
    const secret = process.env.SAAS_WEBHOOK_SECRET;
    if (!url || !secret) return false;
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' || parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    } catch {
      return false; // URL 畸形 → 拒绝启用（onModuleInit 已大声报过配置不完整）
    }
  }

  /**
   * webhook 派送：取到期 PENDING（nextAttemptAt 空或已到）按 id asc 推送。
   * 2xx → ACKED；失败 → 指数退避重试；连续 MAX_WEBHOOK_ATTEMPTS 次 → DEAD（DLQ，人工介入）。
   * 每请求带 HMAC 签名头（x-timestamp + x-signature，验签方式见 packages/contracts/events/WEBHOOK.md）。
   */
  async pumpWebhookDeliveries(now: Date): Promise<void> {
    if (!this.webhookEnabled()) return;
    const url = process.env.SAAS_WEBHOOK_URL as string;
    const secret = process.env.SAAS_WEBHOOK_SECRET as string;
    const due = await this.db.outboxDelivery.findMany({
      where: {
        sink: WEBHOOK_SINK,
        status: 'PENDING',
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
      include: { event: true },
    });
    for (const d of due) {
      try {
        const body = JSON.stringify(toEnvelope(d.event));
        const timestamp = now.toISOString();
        // 签名覆盖 timestamp + body：消费端复算 HMAC 验真伪 + 按时间窗（建议 5min）拒重放。
        const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
        const res = await this.fetchFn(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-timestamp': timestamp,
            'x-signature': `sha256=${signature}`,
          },
          body,
          signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
        });
        if (res.ok) {
          // CAS：只翻 PENDING → ACKED。与 ACK API / 多实例竞态时 count=0 → 已被他方推进，本轮跳过
          // （防把 ACKED 覆写回去或重复置位）。
          await this.db.outboxDelivery.updateMany({
            where: { id: d.id, status: 'PENDING' },
            data: { status: 'ACKED', deliveredAt: now, ackedAt: now },
          });
          continue;
        }
        await this.recordWebhookFailure(d, `HTTP ${res.status}`, now);
      } catch (err) {
        await this.recordWebhookFailure(d, String(err), now);
      }
    }
  }

  /**
   * 失败记账：attempts+1、lastError 截断、指数退避（2^attempts × 30s 封顶 1h）；达阈值 → DEAD。
   * CAS：where 带读时 attempts 做乐观锁 + 仅 PENDING——与 ACK API/双实例竞态时 count=0 →
   * 本轮静默跳过（不 log.error，不把 ACKED 覆写成 DEAD、不丢 attempts 更新）。
   */
  private async recordWebhookFailure(
    d: { id: bigint; eventId: string; attempts: number },
    error: string,
    now: Date,
  ): Promise<void> {
    const attempts = d.attempts + 1;
    const isDead = attempts >= MAX_WEBHOOK_ATTEMPTS;
    const backoffMs = Math.min(BACKOFF_BASE_MS * 2 ** attempts, BACKOFF_CAP_MS);
    const r = await this.db.outboxDelivery.updateMany({
      where: { id: d.id, status: 'PENDING', attempts: d.attempts },
      data: {
        attempts,
        lastError: error.slice(0, MAX_ERROR_LEN),
        nextAttemptAt: new Date(now.getTime() + backoffMs),
        ...(isDead ? { status: 'DEAD' } : {}),
      },
    });
    if (r.count === 0) return; // 乐观锁失手：行已被他方推进（ACK/另一实例记账）
    if (isDead) {
      this.logger.error(
        `webhook delivery for event ${d.eventId} DEAD after ${attempts} attempts (DLQ, 人工介入): ${error.slice(0, 200)}`,
      );
    }
  }

  /** KNW-003/KNW-009：validUntil 到期的已批准事实 → EXPIRED（约每 60s 扫一次）。 */
  private async expireDueClaims(): Promise<void> {
    this.expireCounter = (this.expireCounter + 1) % 30;
    if (this.expireCounter !== 0) return;
    const expired = await this.db.claim.findMany({
      where: { status: 'APPROVED', validUntil: { lt: new Date() } },
      select: { id: true, workspaceId: true, companyId: true, type: true },
      take: 100,
    });
    for (const c of expired) {
      try {
        // 原子成对（E）：EXPIRED 置位与 ClaimExpired 事件同事务——两步分离时若在中间崩溃，
        // 状态已翻但事件永久丢失（ClaimExpired 是对外交付事件，丢失 = SaaS 漏收到期通知）。
        await this.db.$transaction([
          this.db.claim.update({ where: { id: c.id }, data: { status: 'EXPIRED' } }),
          this.db.outboxEvent.create({
            data: {
              workspaceId: c.workspaceId,
              eventType: 'ClaimExpired',
              aggregateType: 'Claim',
              aggregateId: c.id,
              payload: { companyId: c.companyId, type: c.type },
            },
          }),
        ]);
      } catch (err) {
        // 单条失败不阻断本批其余 claim；未翻状态的下轮扫描仍会重试。
        this.logger.error(`claim expiry failed for ${c.id} (下轮重试): ${String(err)}`);
      }
    }
    if (expired.length) this.logger.log(`expired ${expired.length} claims past validUntil`);
  }

  /**
   * 幂等启动工作流（B）：已有同 workflowId 在跑 → 视为已处理（合并语义，事件照常标 published）。
   * 否则事件每 2s 重试直到实例结束——日志风暴 + 假积压。其余错误照旧抛出（下轮重试）。
   * 三个 internal command 共用，不改各自 workflowId reuse policy。
   */
  private async startWorkflowIdempotent(
    workflowType: string,
    options: { taskQueue: string; workflowId: string; args: unknown[] },
    what: string,
  ): Promise<void> {
    try {
      await this.temporal.client.workflow.start(workflowType, options);
      this.logger.log(`started ${what}`);
    } catch (err) {
      if ((err as Error)?.name === 'WorkflowExecutionAlreadyStartedError') {
        this.logger.log(`${what} already running — merged`);
      } else throw err;
    }
  }

  private async dispatch(ev: {
    eventType: string;
    workspaceId: string;
    aggregateId: string;
    payload: unknown;
  }): Promise<void> {
    if (ev.eventType === 'CompanyProfileCreated') {
      const payload = (ev.payload ?? {}) as { website?: string };
      await this.startWorkflowIdempotent(
        UNDERSTANDING_WORKFLOW,
        {
          taskQueue: UNDERSTANDING_TASK_QUEUE,
          workflowId: `understanding-${ev.aggregateId}`,
          args: [
            { workspaceId: ev.workspaceId, companyId: ev.aggregateId, website: payload.website ?? '' },
          ],
        },
        `understanding workflow for company ${ev.aggregateId}`,
      );
    }
    if (ev.eventType === 'DiscoveryRunRequested') {
      const payload = (ev.payload ?? {}) as { planId?: string; icpId?: string };
      await this.startWorkflowIdempotent(
        DISCOVERY_WORKFLOW,
        {
          taskQueue: UNDERSTANDING_TASK_QUEUE,
          workflowId: `discovery-${ev.aggregateId}`,
          args: [
            {
              workspaceId: ev.workspaceId,
              runId: ev.aggregateId,
              planId: payload.planId ?? '',
              icpId: payload.icpId ?? '',
            },
          ],
        },
        `discovery workflow for run ${ev.aggregateId}`,
      );
    }
    if (ev.eventType === 'QualifyRequested') {
      await this.startWorkflowIdempotent(
        QUALIFY_WORKFLOW,
        {
          taskQueue: UNDERSTANDING_TASK_QUEUE,
          // 同一 ICP 重复请求合并到一个在跑实例；跑完可再触发
          workflowId: `qualify-${ev.aggregateId}`,
          args: [{ workspaceId: ev.workspaceId, icpId: ev.aggregateId }],
        },
        `qualify workflow for icp ${ev.aggregateId}`,
      );
    }
    if (ev.eventType === 'DeletionRequested') {
      // 收口⑥ PR-B：起 GDPR Art.17 删除编排。workflowId=deletion-<requestId> 唯一，重放合并到在跑实例。
      const payload = (ev.payload ?? {}) as { subjectType?: string; subjectId?: string };
      await this.startWorkflowIdempotent(
        DELETION_WORKFLOW,
        {
          taskQueue: UNDERSTANDING_TASK_QUEUE,
          workflowId: `deletion-${ev.aggregateId}`,
          args: [
            {
              workspaceId: ev.workspaceId,
              deletionRequestId: ev.aggregateId,
              subjectType: payload.subjectType ?? '',
              subjectId: payload.subjectId ?? '',
            },
          ],
        },
        `deletion workflow for request ${ev.aggregateId}`,
      );
    }
  }
}
