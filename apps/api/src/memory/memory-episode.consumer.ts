import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildProvenance,
  MEMORY_EVENT_TYPES,
  MEMORY_WORKFLOW_DISCOVERY,
  MemoryConsumerConfig,
  parseLeadsScoredPayload,
  parseRunCompletedPayload,
  readMemoryConsumerConfig,
} from './memory.contracts';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;

interface OutboxRow {
  id: bigint;
  eventId: string;
  workspaceId: string;
  eventType: string;
  schemaVersion: number;
  producer: string;
  correlationId: string | null;
  causationId: string | null;
  aggregateId: string;
  payload: unknown;
  occurredAt: Date;
  privacyClassification: string;
}

export interface MemoryConsumerTickResult {
  scanned: number;
  inserted: number;
  failed: number;
}

/**
 * D-MA-7 episodic memory writer.
 *
 * Scans outbox_event (owner connection, read-only, never marks published/parked)
 * for DiscoveryRunCompleted and LeadsScored, then writes mem_run_episode through
 * app_user + withWorkspace so RLS and the append-only grants apply. Disabled by
 * default (`MEMORY_LAYER_V0_ENABLED`); repeated scans are no-ops thanks to the
 * (workspace, workflow, run, phase) unique key.
 */
@Injectable()
export class MemoryEpisodeConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('MemoryEpisodeConsumer');
  private owner?: PrismaClient;
  private ownsOwnerClient = false;
  private readonly config: MemoryConsumerConfig;
  private timer?: NodeJS.Timeout;
  private inFlight = false;
  private shuttingDown = false;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() ownerDb?: PrismaClient,
    @Optional() config?: MemoryConsumerConfig,
  ) {
    this.config = config ?? readMemoryConsumerConfig();
    if (ownerDb) {
      this.owner = ownerDb;
    } else if (this.config.enabled && process.env.DATABASE_URL) {
      // Construct only when enabled: AppModule tests must not need DATABASE_URL.
      this.owner = new PrismaClient({
        datasourceUrl: process.env.DATABASE_URL,
      });
      this.ownsOwnerClient = true;
    }
  }

  onModuleInit(): void {
    if (!this.config.enabled) {
      this.logger.log(
        'memory episode consumer disabled (MEMORY_LAYER_V0_ENABLED!=true)',
      );
      return;
    }
    if (!this.owner) {
      this.logger.error(
        'memory episode consumer requires DATABASE_URL for the cross-tenant outbox scan; staying off',
      );
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.pollMs);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    if (this.timer) clearInterval(this.timer);
    if (this.ownsOwnerClient) {
      await this.owner.$disconnect().catch(() => undefined);
    }
  }

  private async tick(): Promise<void> {
    if (this.inFlight || this.shuttingDown) return;
    this.inFlight = true;
    try {
      const result = await this.runOnce();
      if (result.scanned > 0) {
        this.logger.log(
          `memory episode tick scanned=${result.scanned} inserted=${result.inserted} failed=${result.failed}`,
        );
      }
    } catch (error: unknown) {
      this.logger.error(`memory episode tick failed: ${String(error)}`);
    } finally {
      this.inFlight = false;
    }
  }

  /** One scan pass; public so tests can drive it deterministically. */
  async runOnce(now: Date = new Date()): Promise<MemoryConsumerTickResult> {
    if (this.shuttingDown || !this.owner) {
      return { scanned: 0, inserted: 0, failed: 0 };
    }
    const since = new Date(
      now.getTime() - this.config.lookbackDays * DAY_MS,
    );
    const events = (await this.owner.outboxEvent.findMany({
      where: {
        eventType: { in: [...MEMORY_EVENT_TYPES] },
        occurredAt: { gte: since },
      },
      // Newest first: v0 does not backfill history, and a fixed ascending scan
      // without a cursor would starve on windows holding more than one batch.
      orderBy: { id: 'desc' },
      take: this.config.batchSize,
      select: {
        id: true,
        eventId: true,
        workspaceId: true,
        eventType: true,
        schemaVersion: true,
        producer: true,
        correlationId: true,
        causationId: true,
        aggregateId: true,
        payload: true,
        occurredAt: true,
        privacyClassification: true,
      },
    })) as OutboxRow[];

    let inserted = 0;
    let failed = 0;
    for (const event of events) {
      if (this.shuttingDown) break;
      try {
        inserted += await this.handleEvent(event);
      } catch (error: unknown) {
        failed += 1;
        this.logger.error(
          `memory episode write failed for event ${event.eventId} (${event.eventType}): ${String(error)}`,
        );
      }
    }
    return { scanned: events.length, inserted, failed };
  }

  private async handleEvent(event: OutboxRow): Promise<number> {
    if (event.eventType === 'DiscoveryRunCompleted') {
      return this.handleRunCompleted(event);
    }
    if (event.eventType === 'LeadsScored') {
      return this.handleLeadsScored(event);
    }
    return 0;
  }

  private async handleRunCompleted(event: OutboxRow): Promise<number> {
    if (!UUID_RE.test(event.aggregateId)) {
      throw new Error('DiscoveryRunCompleted aggregateId is not a run UUID');
    }
    const payload = parseRunCompletedPayload(event.payload);
    const provenance = buildProvenance(event);
    return this.prisma.withWorkspace(event.workspaceId, async (tx) => {
      const run = await tx.discoveryRun.findUnique({
        where: { id: event.aggregateId },
        select: { id: true },
      });
      if (!run) return 0;
      const result = await tx.memRunEpisode.createMany({
        data: [
          {
            workspaceId: event.workspaceId,
            workflowType: MEMORY_WORKFLOW_DISCOVERY,
            runId: event.aggregateId,
            phase: 'run_completed',
            occurredAt: event.occurredAt,
            sourceEventId: event.eventId,
            payload: payload as unknown as Prisma.InputJsonValue,
            provenance: provenance as unknown as Prisma.InputJsonValue,
            privacyClassification: event.privacyClassification,
          },
        ],
        skipDuplicates: true,
      });
      return result.count;
    });
  }

  private async handleLeadsScored(event: OutboxRow): Promise<number> {
    const icpId = event.aggregateId;
    if (!UUID_RE.test(icpId)) {
      throw new Error('LeadsScored aggregateId is not an ICP UUID');
    }
    const payload = parseLeadsScoredPayload(event.payload);
    const provenance = buildProvenance(event);
    const windowStart = new Date(
      event.occurredAt.getTime() - this.config.lookbackDays * DAY_MS,
    );
    return this.prisma.withWorkspace(event.workspaceId, async (tx) => {
      const runs = await tx.discoveryRun.findMany({
        where: {
          icpId,
          completedAt: {
            not: null,
            lte: event.occurredAt,
            gte: windowStart,
          },
        },
        select: { id: true },
        orderBy: { completedAt: 'desc' },
        take: 50,
      });
      if (runs.length === 0) return 0;
      const runIds = runs.map((run) => run.id);
      const [phaseOne, phaseTwo] = await Promise.all([
        tx.memRunEpisode.findMany({
          where: {
            workflowType: MEMORY_WORKFLOW_DISCOVERY,
            phase: 'run_completed',
            runId: { in: runIds },
          },
          select: { runId: true },
        }),
        tx.memRunEpisode.findMany({
          where: {
            workflowType: MEMORY_WORKFLOW_DISCOVERY,
            phase: 'results_backfilled',
            runId: { in: runIds },
          },
          select: { runId: true },
        }),
      ]);
      const hasPhaseOne = new Set(phaseOne.map((row) => row.runId));
      const hasPhaseTwo = new Set(phaseTwo.map((row) => row.runId));
      const candidates = runs.filter(
        (run) => hasPhaseOne.has(run.id) && !hasPhaseTwo.has(run.id),
      );
      if (candidates.length === 0) return 0;
      const result = await tx.memRunEpisode.createMany({
        data: candidates.map((run) => ({
          workspaceId: event.workspaceId,
          workflowType: MEMORY_WORKFLOW_DISCOVERY,
          runId: run.id,
          phase: 'results_backfilled',
          occurredAt: event.occurredAt,
          sourceEventId: event.eventId,
          payload: payload as unknown as Prisma.InputJsonValue,
          provenance: provenance as unknown as Prisma.InputJsonValue,
          privacyClassification: event.privacyClassification,
        })),
        skipDuplicates: true,
      });
      return result.count;
    });
  }
}
