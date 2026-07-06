import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { TemporalClient } from '../temporal/temporal.client';
import {
  DISCOVERY_WORKFLOW,
  QUALIFY_WORKFLOW,
  UNDERSTANDING_TASK_QUEUE,
  UNDERSTANDING_WORKFLOW,
} from '../temporal/understanding.constants';
import { DiscoveryProviderRegistry } from '../discovery/provider.registry';

/**
 * Transactional Outbox relay (ADR-009). A trusted system scanner: connects as the
 * owner (DATABASE_URL) to read unpublished events ACROSS all tenants — RLS would
 * hide them from app_user. Dispatched work (workflow activities) is tenant-scoped
 * again via withWorkspace. Dev uses simple polling; prod can move to LISTEN/NOTIFY.
 */
@Injectable()
export class OutboxRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('OutboxRelay');
  private readonly db = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly temporal: TemporalClient) {}

  async onModuleInit(): Promise<void> {
    await this.db.$connect();
    // 平台配置播种（data_provider 无 RLS，owner 连接写入）
    await new DiscoveryProviderRegistry().seed(this.db).catch((err) => {
      this.logger.warn(`provider seed failed: ${String(err)}`);
    });
    this.timer = setInterval(() => {
      void this.tick();
    }, 2000);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.db.$disconnect();
  }

  private async tick(): Promise<void> {
    if (this.running) return; // avoid overlapping ticks
    this.running = true;
    try {
      const events = await this.db.outboxEvent.findMany({
        where: { publishedAt: null },
        orderBy: { id: 'asc' },
        take: 20,
      });
      for (const ev of events) {
        try {
          await this.dispatch(ev);
          await this.db.outboxEvent.update({
            where: { id: ev.id },
            data: { publishedAt: new Date() },
          });
        } catch (err) {
          this.logger.error(`dispatch failed for event ${ev.eventId}: ${String(err)}`);
        }
      }
    } catch (err) {
      this.logger.error(`relay tick failed: ${String(err)}`);
    } finally {
      this.running = false;
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
      await this.temporal.client.workflow.start(UNDERSTANDING_WORKFLOW, {
        taskQueue: UNDERSTANDING_TASK_QUEUE,
        workflowId: `understanding-${ev.aggregateId}`,
        args: [
          { workspaceId: ev.workspaceId, companyId: ev.aggregateId, website: payload.website ?? '' },
        ],
      });
      this.logger.log(`started understanding workflow for company ${ev.aggregateId}`);
    }
    if (ev.eventType === 'DiscoveryRunRequested') {
      const payload = (ev.payload ?? {}) as { planId?: string; icpId?: string };
      await this.temporal.client.workflow.start(DISCOVERY_WORKFLOW, {
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
      });
      this.logger.log(`started discovery workflow for run ${ev.aggregateId}`);
    }
    if (ev.eventType === 'QualifyRequested') {
      await this.temporal.client.workflow.start(QUALIFY_WORKFLOW, {
        taskQueue: UNDERSTANDING_TASK_QUEUE,
        // 同一 ICP 重复请求合并到一个在跑实例；跑完可再触发
        workflowId: `qualify-${ev.aggregateId}`,
        args: [{ workspaceId: ev.workspaceId, icpId: ev.aggregateId }],
      });
      this.logger.log(`started qualify workflow for icp ${ev.aggregateId}`);
    }
    // Other event types: no handler yet (still marked published).
  }
}
