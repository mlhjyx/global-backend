import { discoveryManufacturerCommandArguments, NonRetryableOutboxCommandError, resolveDiscoveryWorkflowType } from './discovery-run-command';
import { dispatchRejudgeCommand } from './rejudge-command';
import { assertCandidateWorkspaceAllowed, assertRuntimeCandidateOperational, candidateWorkspaceWhere } from '../runtime/development-candidate';
import { createHmac } from "node:crypto";
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { WorkflowIdReusePolicy } from "@temporalio/client";
import type { Duration } from "@temporalio/common";
import { TemporalClient } from "../temporal/temporal.client";
import { DevFastLaneTemporalClient } from "../temporal/dev-fast-lane-temporal.client";
import { DEV_FAST_LANE_ACQUISITION_COMMANDS } from "../runtime/dev-fast-lane";
import {
  DELETION_WORKFLOW,
  DISCOVERY_WORKFLOW,
  ASSET_OBJECT_CLEANUP_WORKFLOW,
  QUALIFY_WORKFLOW,
  PERSONAL_ARTIFACT_CLEANUP_WORKFLOW,
  UNDERSTANDING_WORKFLOW,
} from "../temporal/understanding.constants";
import { formatTenantWorkflowId } from "../temporal/tenant-workflow-id";
import { resolveCustomerTaskQueue } from "../temporal/tenant-task-queues";
import { DISCOVERY_RUN_EXECUTION_TIMEOUT } from "../temporal/discovery-run-lifecycle";
import {
  DISCOVERY_WORKFLOW_KNOB_ENV,
  DISCOVERY_DEEP_COMPANY_CONCURRENCY_BOUNDS,
  DISCOVERY_DEEP_COMPANY_CONCURRENCY_DEFAULT,
  DISCOVERY_POOL_SEARCH_FALLBACK_THRESHOLD_BOUNDS,
  DISCOVERY_POOL_SEARCH_FALLBACK_THRESHOLD_DEFAULT,
  DISCOVERY_QUERY_BATCH_SIZE_BOUNDS,
  DISCOVERY_QUERY_BATCH_SIZE_DEFAULT,
  boundedKnob,
  type WorkflowKnobBounds,
} from "../temporal/discovery.workflow-knobs";
import {
  assertMigrationCompatible,
  RuntimeProcessLeaseService,
} from "../runtime/runtime-process-lease";
import { RuntimeAdmissionService } from "../runtime/runtime-admission";
import { RuntimeReleaseIdentityService } from "../runtime/runtime-release-identity";
import { completesWithin, settlesWithin } from "../runtime/bounded-settlement";
import {
  assertScopedDatabasePrincipal,
  inspectScopedDatabaseUrl,
  OUTBOX_RELAY_DATABASE_ROLE,
} from "../runtime/scoped-database-principal";
import { DEFAULT_EXPECTED_PROVIDER_KEYS, verifyPlatformCatalogsReadOnly } from "../runtime/platform-catalog-verification";
import { SANCTIONS_SOURCE_SEEDS } from "../sanctions/sanctions-seed";
import { BUILTIN_SKILLS } from "../skills/generated/builtin-skill-catalog";
import { BUILTIN_PACKS } from "../skills/packs/generated/builtin-pack-catalog";
import { BUILTIN_AGENTS } from "../agents/agent-catalog";
import {
  parseExecutionBudgetBinding,
  type ExecutionBudgetBinding,
} from "../execution-budget/execution-budget-binding";
import {
  INTEGRATION_EVENTS,
  INTERNAL_COMMANDS,
  PULL_SINK,
  WEBHOOK_SINK,
  toEnvelope,
  validateIntegrationEvent,
} from "./event-registry";
import {
  assertPersonalArtifactCleanupOutboxPayload,
  logIntegrationPayloadWarning,
  parseAssetCleanupOutboxCommand,
  qualifyWorkflowArgs,
} from "./event-payload-helpers";
import { OutboxDispatchBackoff, tryWithOutboxAdvisoryLock } from "./outbox-retry-guard";
import { createOptionalOutboxWakeup, type OutboxWakeupController } from "./outbox-wakeup";

/** Transactional Outbox relay (ADR-009): DATABASE_URL owner scans across tenants;
 * dispatched workflow activities reapply tenant scope through withWorkspace.
 * Internal commands dispatch to Temporal; integration events atomically enter outbox_delivery;
 * unknown types park. The webhook sink retries with backoff, DLQ and HMAC signatures.
 * GET /events cursor ordering requires one writer for delivery rows. A multi-replica
 * relay needs a PostgreSQL advisory lock before dispatch to maintain that ordering.
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

/** Development fast lane only: the outbox filter for the lane workspace's acquisition commands. */
type LaneCommandFilter = Readonly<{
  workspaceId: string;
  eventType: { in: string[] };
}>;

/** fetch 的最小可注入面（单测 mock 用，绝不真发网络）。 */
type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    redirect?: RequestRedirect;
    signal: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; body?: { cancel?: () => Promise<unknown> | void } | null }>;

@Injectable()
export class OutboxRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("OutboxRelay");
  private readonly db?: PrismaClient;
  private readonly ownsDb: boolean;
  private principalVerified = false;
  private readonly fetchFn: FetchLike;
  private timer?: NodeJS.Timeout;
  private wakeup?: OutboxWakeupController;
  private running = false;
  private expireCounter = 0;
  private initialized = false;
  private leaseStartingAttempted = false;
  private leaseStartingPublished = false;
  private shuttingDown = false;
  private managedTickInFlight?: Promise<void>;
  // Development fast lane only: the in-flight lane pass (scheduleLanePass).
  private laneInFlight?: Promise<void>;
  private readonly dispatchBackoff = new OutboxDispatchBackoff();
  private readonly shutdownAbort = new AbortController();
  private readiness:
    | Readonly<{ status: "ready" }>
    | Readonly<{
        status: "not_ready";
        code:
          | "OUTBOX_RELAY_DATABASE_UNAVAILABLE"
          | "OUTBOX_RELAY_RUNTIME_ADMISSION_CLOSED"
          | "OUTBOX_RELAY_MIGRATION_MISMATCH";
      }> = {
    status: "not_ready",
    code: "OUTBOX_RELAY_DATABASE_UNAVAILABLE",
  };

  constructor(
    private readonly temporal: TemporalClient,
    // 可选注入（@Optional：Nest 无 provider 时注入 undefined）→ 单测传 mock db/fetch，生产走默认。
    @Optional() db?: PrismaClient,
    @Optional() fetchFn?: FetchLike,
    @Optional() private readonly leases?: RuntimeProcessLeaseService,
    @Optional() private readonly admission?: RuntimeAdmissionService,
    @Optional()
    private readonly releaseIdentity?: RuntimeReleaseIdentityService,
    // Development fast lane only (dev-fast-lane.ts); absent or disabled keeps
    // every command on the managed Temporal and the 'understanding' queue.
    @Optional() private readonly devFastLane?: DevFastLaneTemporalClient,
  ) {
    if (db) {
      this.db = db;
      this.ownsDb = false;
      this.principalVerified = true;
    } else {
      const check = inspectScopedDatabaseUrl(
        "OUTBOX_RELAY_DATABASE_URL",
        process.env.OUTBOX_RELAY_DATABASE_URL,
      );
      if (check.status === "ok") {
        this.db = new PrismaClient({
          datasourceUrl: process.env.OUTBOX_RELAY_DATABASE_URL,
        });
        this.ownsDb = true;
      } else {
        this.db = undefined;
        this.ownsDb = false;
        this.logger.error(
          `outbox relay requires OUTBOX_RELAY_DATABASE_URL (${OUTBOX_RELAY_DATABASE_ROLE}): ${check.code}`,
        );
      }
    }
    this.fetchFn = fetchFn ?? ((url, init) => fetch(url, init));
  }

  private requireDb(): PrismaClient {
    if (!this.db) {
      throw new Error("OUTBOX_RELAY_DATABASE_UNAVAILABLE");
    }
    return this.db;
  }

  async onModuleInit(): Promise<void> {
    await this.reconnect();
    this.wakeup = createOptionalOutboxWakeup(this.ownsDb, () => { void this.scheduleManagedTick(); });
    this.timer = setInterval(() => {
      void this.scheduleManagedTick();
    }, 2000);
    this.timer.unref();
  }

  getReadiness():
    | Readonly<{ status: "ready" }>
    | Readonly<{
        status: "not_ready";
        code:
          | "OUTBOX_RELAY_DATABASE_UNAVAILABLE"
          | "OUTBOX_RELAY_RUNTIME_ADMISSION_CLOSED"
          | "OUTBOX_RELAY_MIGRATION_MISMATCH";
      }> {
    return this.readiness;
  }

  async reconnect(): Promise<boolean> {
    if (this.shuttingDown) return false;
    if (!this.db) {
      this.readiness = {
        status: "not_ready",
        code: "OUTBOX_RELAY_DATABASE_UNAVAILABLE",
      };
      return false;
    }
    if (this.admission && !this.admission.current().admitted) {
      this.readiness = {
        status: "not_ready",
        code: "OUTBOX_RELAY_RUNTIME_ADMISSION_CLOSED",
      };
      this.logger.error(
        "outbox relay runtime admission is closed; relay remains non-consuming",
      );
      return false;
    }
    try {
      await this.db.$connect();
      if (this.ownsDb && !this.principalVerified) {
        await assertScopedDatabasePrincipal(
          this.db,
          OUTBOX_RELAY_DATABASE_ROLE,
          "OutboxRelayService",
        );
        this.principalVerified = true;
      }
      if (!(await this.migrationCompatible())) return false;
      if (this.shuttingDown) return false;
      if (!this.leaseStartingPublished) {
        this.leaseStartingAttempted = true;
        await this.leases?.heartbeat("OUTBOX_RELAY", "STARTING", null);
        if (this.shuttingDown) return false;
        this.leaseStartingPublished = true;
      }
      if (!this.initialized) {
        await this.initializePlatformState();
        if (this.shuttingDown) return false;
        this.initialized = true;
      }
      await this.leases?.heartbeat("OUTBOX_RELAY", "READY", null);
      if (this.shuttingDown) return false;
      this.readiness = { status: "ready" };
      return true;
    } catch {
      this.readiness = {
        status: "not_ready",
        code: "OUTBOX_RELAY_DATABASE_UNAVAILABLE",
      };
      this.logger.error(
        "outbox relay database initialization unavailable; readiness remains closed",
      );
      return false;
    }
  }

  async initializePlatformState(): Promise<void> {
    assertRuntimeCandidateOperational();
    const db = this.requireDb();
    // 部署期已通过 seed-platform-catalogs 写入平台目录；运行时仅用 runtime_outbox_relay_worker 做只读就绪校验。
    await verifyPlatformCatalogsReadOnly(db, {
      expectedProviderKeys: DEFAULT_EXPECTED_PROVIDER_KEYS,
      expectedSanctionsKeys: SANCTIONS_SOURCE_SEEDS.map((s) => s.key),
      expectedSkillVersions: BUILTIN_SKILLS.map((s) => ({
        skillKey: s.manifest.platform.skillKey,
        version: s.manifest.platform.version,
      })),
      expectedPackVersions: BUILTIN_PACKS.map((p) => ({
        packKey: p.manifest.packKey,
        version: p.manifest.version,
      })),
      expectedAgentKeys: BUILTIN_AGENTS.map((a) => a.agentKey),
    });
    // webhook 配置不完整要**大声**：URL 配了但缺 secret / 非 https（非 localhost）→ sink 拒绝启用，
    // 推送通道既不建交付行也不派送——只报一次，不让运维以为推送在跑。
    if (process.env.SAAS_WEBHOOK_URL && !this.webhookEnabled()) {
      this.logger.error(
        "SAAS_WEBHOOK_URL 已配置但 webhook sink 拒绝启用：需同时配 SAAS_WEBHOOK_SECRET 且 URL 为 https://（dev 例外：localhost/127.0.0.1）。当前不建 webhook 交付行、不派送。",
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    this.shutdownAbort.abort();
    if (this.timer) clearInterval(this.timer);
    await this.wakeup?.close().catch(() => undefined);
    this.wakeup = undefined;
    this.readiness = {
      status: "not_ready",
      code: "OUTBOX_RELAY_DATABASE_UNAVAILABLE",
    };
    if (this.leaseStartingPublished) {
      const drainingPublished = await settlesWithin(
        this.leases?.heartbeat("OUTBOX_RELAY", "DRAINING", null) ??
          Promise.resolve(),
      );
      if (!drainingPublished) {
        this.logger.error("outbox relay draining heartbeat failed");
      }
    }
    const inFlight = [this.managedTickInFlight, this.laneInFlight].filter(
      (pending): pending is Promise<void> => pending !== undefined,
    );
    const drained =
      inFlight.length > 0
        ? await completesWithin(Promise.allSettled(inFlight))
        : true;
    if (this.leaseStartingPublished) {
      if (drained) {
        const stoppedPublished = await settlesWithin(
          this.leases?.heartbeat("OUTBOX_RELAY", "STOPPED", null) ??
            Promise.resolve(),
        );
        if (!stoppedPublished) {
          this.logger.error("outbox relay stop heartbeat failed");
          await this.atomicTerminalizeUncertainLease();
        }
      } else {
        this.logger.error(
          "outbox relay shutdown timed out; lease remains DRAINING",
        );
      }
    }
    if (this.leaseStartingAttempted && !this.leaseStartingPublished) {
      await this.atomicTerminalizeUncertainLease();
    }
    if (this.db) {
      const disconnected = await completesWithin(
        this.db.$disconnect().catch(() => undefined),
      );
      if (!disconnected) {
        this.logger.error("outbox relay database disconnect timed out");
      }
    }
    this.readiness = {
      status: "not_ready",
      code: "OUTBOX_RELAY_DATABASE_UNAVAILABLE",
    };
  }

  private async atomicTerminalizeUncertainLease(): Promise<void> {
    const terminalized = await settlesWithin(
      this.leases?.terminalize("OUTBOX_RELAY", null) ?? Promise.resolve(),
    );
    if (!terminalized) {
      this.logger.error("outbox relay atomic terminalization failed");
    }
  }

  private scheduleManagedTick(): Promise<void> {
    if (this.shuttingDown) return Promise.resolve();
    if (this.managedTickInFlight) return this.managedTickInFlight;
    const pending = this.managedTick().finally(() => {
      if (this.managedTickInFlight === pending) {
        this.managedTickInFlight = undefined;
      }
    });
    this.managedTickInFlight = pending;
    return pending;
  }

  private async managedTick(): Promise<void> {
    if (this.shuttingDown) return;
    if (this.readiness.status !== "ready" && !(await this.reconnect())) return;
    if (!(await this.migrationCompatible())) return;
    if (this.shuttingDown) return;
    try {
      await this.leases?.heartbeat("OUTBOX_RELAY", "READY", null);
    } catch {
      this.readiness = {
        status: "not_ready",
        code: "OUTBOX_RELAY_DATABASE_UNAVAILABLE",
      };
      this.logger.error(
        "outbox relay heartbeat failed; readiness remains closed",
      );
      return;
    }
    if (this.shuttingDown) return;
    await this.tick();
  }

  private async migrationCompatible(): Promise<boolean> {
    if (!this.db) return false;
    if (!this.releaseIdentity) return true;
    try {
      await assertMigrationCompatible(
        this.db as never,
        this.releaseIdentity.current(),
      );
      return true;
    } catch {
      this.readiness = {
        status: "not_ready",
        code: "OUTBOX_RELAY_MIGRATION_MISMATCH",
      };
      this.logger.error(
        "outbox relay migration is incompatible; relay remains non-consuming",
      );
      return false;
    }
  }

  async tick(): Promise<void> {
    assertRuntimeCandidateOperational();
    const db = this.requireDb();
    if (this.running) return; // avoid overlapping ticks
    this.running = true;
    try {
      await tryWithOutboxAdvisoryLock(db as never, async () => {
        await this.expireDueClaims();
        if (this.shuttingDown) return;
        const laneCommands = this.devFastLaneCommands();
        const coolingIds = this.dispatchBackoff.coolingEventIds();
        const events = (await db.outboxEvent.findMany({
          where: { publishedAt: null, parkedAt: null, ...(coolingIds.length ? { eventId: { notIn: coolingIds } } : {}), ...(laneCommands ? { NOT: laneCommands } : {}), ...candidateWorkspaceWhere() },
          orderBy: { id: "asc" },
          take: BATCH_SIZE,
        })) as OutboxEventRecord[];
        for (const ev of events) {
          if (this.shuttingDown) break;
          await this.routeEvent(ev);
        }
        if (laneCommands) this.scheduleLanePass(laneCommands);
        if (!this.shuttingDown && this.webhookEnabled()) {
          await this.pumpWebhookDeliveries(new Date());
        }
      });
    } catch (err) {
      this.logger.error(`relay tick failed: ${String(err)}`);
    } finally {
      this.running = false;
    }
  }

  private devFastLaneCommands(): LaneCommandFilter | undefined {
    const lane = this.devFastLane?.lane;
    return lane?.enabled
      ? {
          workspaceId: lane.workspaceId,
          eventType: { in: [...DEV_FAST_LANE_ACQUISITION_COMMANDS] },
        }
      : undefined;
  }

  /**
   * Development fast lane only. Routes the lane workspace's acquisition
   * commands in a single-flight pass that the managed tick starts but does not
   * await. A slow or unreachable development Temporal therefore never delays
   * the OUTBOX_RELAY heartbeat or any other workspace's commands. Shutdown
   * aborts a pending lane start and drains the pass with the managed tick.
   */
  private scheduleLanePass(laneCommands: LaneCommandFilter): void {
    if (this.shuttingDown || this.laneInFlight) return;
    const pending = this.lanePass(laneCommands)
      .catch((err: unknown) => {
        this.logger.error(`dev fast lane pass failed: ${String(err)}`);
      })
      .finally(() => {
        if (this.laneInFlight === pending) this.laneInFlight = undefined;
      });
    this.laneInFlight = pending;
  }

  private async lanePass(laneCommands: LaneCommandFilter): Promise<void> {
    assertCandidateWorkspaceAllowed(laneCommands.workspaceId);
    const db = this.requireDb();
    const devFastLane = this.devFastLane;
    if (!devFastLane || devFastLane.coolingDown()) return;
    const events = (await db.outboxEvent.findMany({
      where: { publishedAt: null, parkedAt: null, ...laneCommands },
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
    })) as OutboxEventRecord[];
    for (const ev of events) {
      // A failure to reach the development Temporal starts the client's
      // cool-down; the rest of the batch waits for the next attempt instead of
      // paying the connect budget once per command.
      if (this.shuttingDown || devFastLane.coolingDown()) break;
      await this.routeEvent(ev);
    }
  }

  /**
   * 三分支路由（每事件自吞错误：单事件失败不阻断本批其余事件）。
   * 1. internal command → dispatch Temporal，成功才标 published（行为保持，失败下轮重试）。
   * 2. integration 事件 → **单事务**建交付行 + 标 published；崩溃在两步间 → 重跑 skipDuplicates 幂等。
   * 3. 未注册类型 → parkedAt 停靠 + error 大声（新增事件类型忘记注册是 bug）。
   */
  async routeEvent(ev: OutboxEventRecord): Promise<void> {
    assertCandidateWorkspaceAllowed(ev.workspaceId);
    const db = this.requireDb();
    if (INTERNAL_COMMANDS.has(ev.eventType)) {
      try {
        await this.dispatch(ev);
        await db.outboxEvent.update({
          where: { id: ev.id },
          data: { publishedAt: new Date() },
        });
        this.dispatchBackoff.clear(ev.eventId);
      } catch (err) {
        if (err instanceof NonRetryableOutboxCommandError) {
          await db.outboxEvent.update({
            where: { id: ev.id },
            data: { parkedAt: new Date() },
          });
          this.dispatchBackoff.clear(ev.eventId);
          this.logger.error(
            `invalid internal command ${ev.eventId} parked: ${err.message}`,
          );
          return;
        }
        this.dispatchBackoff.recordFailure(ev.eventId);
        this.logger.error(
          `dispatch failed for event ${ev.eventId}: ${String(err)}`,
        );
      }
      return;
    }
    if (INTEGRATION_EVENTS.has(ev.eventType)) {
      if (!validateIntegrationEvent(ev)) {
        await db.outboxEvent.update({
          where: { id: ev.id },
          data: { parkedAt: new Date() },
        });
        this.logger.error(
          `invalid integration event ${ev.eventId} parked: payload contract mismatch`,
        );
        return;
      }
      logIntegrationPayloadWarning(this.logger, ev);
      const sinks = [PULL_SINK, ...(this.webhookEnabled() ? [WEBHOOK_SINK] : [])];
      try {
        await db.$transaction(async (tx) => {
          await tx.outboxDelivery.createMany({
            data: sinks.map((sink) => ({
              workspaceId: ev.workspaceId,
              eventId: ev.eventId,
              sink,
            })),
            skipDuplicates: true,
          });
          await tx.outboxEvent.update({
            where: { id: ev.id },
            data: { publishedAt: new Date() },
          });
        });
      } catch (err) {
        this.logger.error(
          `delivery routing failed for event ${ev.eventId}: ${String(err)}`,
        );
      }
      return;
    }
    // 未注册类型：停靠（不标 published——那是假发布；不留在轮询里——那是毒化）。
    try {
      await db.outboxEvent.update({
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
      return (
        parsed.protocol === "https:" ||
        parsed.hostname === "localhost" ||
        parsed.hostname === "127.0.0.1"
      );
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
    assertRuntimeCandidateOperational();
    if (this.shuttingDown || !this.webhookEnabled()) return;
    const url = process.env.SAAS_WEBHOOK_URL as string;
    const secret = process.env.SAAS_WEBHOOK_SECRET as string;
    const db = this.requireDb();
    const due = await db.outboxDelivery.findMany({
      where: {
        sink: WEBHOOK_SINK,
        status: "PENDING",
        ...candidateWorkspaceWhere(),
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
      include: { event: true },
    });
    const batchStartedMs = Date.now();
    for (let idx = 0; idx < due.length; idx += 1) {
      const d = due[idx]!;
      assertCandidateWorkspaceAllowed(d.workspaceId);
      if (this.shuttingDown) break;
      const attemptNow = idx === 0 ? now : new Date(now.getTime() + Math.max(0, Date.now() - batchStartedMs));
      try {
        const body = JSON.stringify(toEnvelope(d.event));
        const timestamp = attemptNow.toISOString();
        const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
        const res = await this.fetchFn(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-timestamp": timestamp, "x-signature": `sha256=${signature}` },
          body,
          redirect: "error",
          signal: AbortSignal.any([AbortSignal.timeout(WEBHOOK_TIMEOUT_MS), this.shutdownAbort.signal]),
        });
        await Promise.resolve(res.body?.cancel?.()).catch(() => undefined);
        if (this.shuttingDown) break;
        if (res.ok) {
          await db.outboxDelivery.updateMany({ where: { id: d.id, status: "PENDING" }, data: { status: "ACKED", deliveredAt: attemptNow, ackedAt: attemptNow } });
          continue;
        }
        await this.recordWebhookFailure(d, `HTTP ${res.status}`, attemptNow);
      } catch (err) {
        if (this.shuttingDown) break;
        await this.recordWebhookFailure(d, String(err), attemptNow);
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
    const db = this.requireDb();
    const attempts = d.attempts + 1;
    const isDead = attempts >= MAX_WEBHOOK_ATTEMPTS;
    const backoffMs = Math.min(BACKOFF_BASE_MS * 2 ** attempts, BACKOFF_CAP_MS);
    const r = await db.outboxDelivery.updateMany({
      where: { id: d.id, status: "PENDING", attempts: d.attempts },
      data: {
        attempts,
        lastError: error.slice(0, MAX_ERROR_LEN),
        nextAttemptAt: new Date(now.getTime() + backoffMs),
        ...(isDead ? { status: "DEAD" } : {}),
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
    assertRuntimeCandidateOperational();
    const db = this.requireDb();
    this.expireCounter = (this.expireCounter + 1) % 30;
    if (this.expireCounter !== 0) return;
    const now = new Date();
    const expired = await db.claim.findMany({
      where: { status: "APPROVED", validUntil: { lt: now }, ...candidateWorkspaceWhere() },
      select: {
        id: true,
        workspaceId: true,
        companyId: true,
        factKey: true,
        type: true,
        version: true,
      },
      take: 100,
    });
    let expiredCount = 0;
    for (const c of expired) {
      assertCandidateWorkspaceAllowed(c.workspaceId);
      try {
        // 原子成对（E）：CAS 状态翻转与 ClaimExpired 同事务。读后若人工 revoke/
        // re-approve 已推进 status/version，CAS 失手且不伪造过期事件。
        const changed = await db.$transaction(async (tx) => {
          const update = await tx.claim.updateMany({
            where: {
              id: c.id,
              status: "APPROVED",
              version: c.version,
              validUntil: { lt: now },
            },
            data: { status: "EXPIRED", version: { increment: 1 } },
          });
          if (update.count === 0) return false;
          await tx.outboxEvent.create({
            data: {
              workspaceId: c.workspaceId,
              eventType: "ClaimExpired",
              aggregateType: "Claim",
              aggregateId: c.id,
              payload: {
                companyId: c.companyId,
                factKey: c.factKey,
                type: c.type,
              },
            },
          });
          return true;
        });
        if (changed) expiredCount += 1;
      } catch (err) {
        // 单条失败不阻断本批其余 claim；未翻状态的下轮扫描仍会重试。
        this.logger.error(
          `claim expiry failed for ${c.id} (下轮重试): ${String(err)}`,
        );
      }
    }
    if (expiredCount) {
      this.logger.log(`expired ${expiredCount} claims past validUntil`);
    }
  }

  /**
   * 幂等启动工作流（B）：已有同 workflowId 在跑 → 视为已处理（合并语义，事件照常标 published）。
   * 否则事件每 2s 重试直到实例结束——日志风暴 + 假积压。其余错误照旧抛出（下轮重试）。
   * 各 internal command 共用；reuse policy 由调用方逐个决定，未指定时用 Temporal 默认
   * （同 ID 的上一次执行结束后允许再启动）。指定 REJECT_DUPLICATE 时，同 ID 已结束也报
   * WorkflowExecutionAlreadyStartedError，同样按合并处理。
   */
  /** M0③：Run 2.0 快扫编排的部署开关（默认关；影子验收后由 M0⑥ 切默认）。 */
  private run2QuickScanEnabled(): boolean {
    return /^(1|true|on|yes)$/i.test(process.env.DISCOVERY_RUN2_QUICK_SCAN ?? "");
  }

  /** M0⑥：影子对比开关（默认关；连续两轮召回不降后再开快扫默认）。 */
  private run2ShadowEnabled(): boolean {
    return /^(1|true|on|yes)$/i.test(process.env.DISCOVERY_RUN2_SHADOW ?? "");
  }

  /**
   * B1（L01）：把参与工作流控制流的可调常量**显式**写进启动输入（随 run 记录进历史，
   * 之后改代码常量或 env 都不影响在飞 run 的重放）。env 只在启动时读一次；非整数回落
   * 冻结默认并告警；越界值在这里（注入点）夹取——workflow 重放从不用可变区间二次夹取，
   * 所以日后调整 BOUNDS 不会改变已录制历史的调度结果（见 discovery.workflow-knobs.ts）。
   */
  private discoveryWorkflowKnobs(): {
    run2PoolSearchFallbackThreshold: number;
    deepCompanyConcurrency: number;
    discoveryQueryBatchSize: number;
  } {
    const read = (envName: string, fallback: number, bounds: WorkflowKnobBounds): number => {
      const raw = process.env[envName];
      if (raw === undefined || raw.trim() === "") return fallback;
      const parsed = Number(raw);
      if (!Number.isInteger(parsed)) {
        this.logger.warn(`${envName}='${raw}' is not an integer — using frozen default ${fallback}`);
        return fallback;
      }
      const clamped = boundedKnob(parsed, fallback, bounds);
      if (clamped !== parsed) {
        this.logger.warn(
          `${envName}=${parsed} is outside [${bounds.min}, ${bounds.max}] — using ${clamped}`,
        );
      }
      return clamped;
    };
    return {
      run2PoolSearchFallbackThreshold: read(
        DISCOVERY_WORKFLOW_KNOB_ENV.run2PoolSearchFallbackThreshold,
        DISCOVERY_POOL_SEARCH_FALLBACK_THRESHOLD_DEFAULT,
        DISCOVERY_POOL_SEARCH_FALLBACK_THRESHOLD_BOUNDS,
      ),
      deepCompanyConcurrency: read(
        DISCOVERY_WORKFLOW_KNOB_ENV.deepCompanyConcurrency,
        DISCOVERY_DEEP_COMPANY_CONCURRENCY_DEFAULT,
        DISCOVERY_DEEP_COMPANY_CONCURRENCY_BOUNDS,
      ),
      discoveryQueryBatchSize: read(
        DISCOVERY_WORKFLOW_KNOB_ENV.discoveryQueryBatchSize,
        DISCOVERY_QUERY_BATCH_SIZE_DEFAULT,
        DISCOVERY_QUERY_BATCH_SIZE_BOUNDS,
      ),
    };
  }

  private async startDeletionCommand(ev: { aggregateId: string; workspaceId: string; eventType: string; payload: unknown }): Promise<void> {
    const payload = (ev.payload ?? {}) as { subjectType?: string; subjectId?: string };
    if (ev.eventType === "SellerDocumentCleanupRequested" && (payload.subjectType !== "seller_document" || typeof payload.subjectId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(payload.subjectId)))
      throw new NonRetryableOutboxCommandError("seller document cleanup payload contract mismatch");
    await this.startWorkflowIdempotent(DELETION_WORKFLOW, {
      taskQueue: resolveCustomerTaskQueue("batch"),
      workflowId: formatTenantWorkflowId(ev.workspaceId, "deletion", ev.aggregateId),
      args: [{ workspaceId: ev.workspaceId, deletionRequestId: ev.aggregateId, subjectType: payload.subjectType ?? "", subjectId: payload.subjectId ?? "" }],
    }, `deletion workflow for request ${ev.aggregateId}`);
  }
  private async startWorkflowIdempotent(
    workflowType: string,
    options: {
      taskQueue: string;
      workflowId: string;
      args: unknown[];
      workflowIdReusePolicy?: WorkflowIdReusePolicy;
      /** B3（F2）：discovery 等长任务的总时限；超时终止后由 stale-run 看门狗收尾。 */
      workflowExecutionTimeout?: Duration;
    },
    what: string,
    acquisitionCommand?: { eventType: string; workspaceId: string },
  ): Promise<void> {
    // Development fast lane: only the three acquisition commands pass
    // `acquisitionCommand`, and only the lane workspace's get a route.
    const laneRoute = acquisitionCommand
      ? (this.devFastLane?.route(
          acquisitionCommand.eventType,
          acquisitionCommand.workspaceId,
        ) ?? null)
      : null;
    const described = laneRoute
      ? `${what} on dev fast lane task queue '${laneRoute.taskQueue}'`
      : what;
    try {
      if (laneRoute && this.devFastLane) {
        await this.devFastLane.start(
          workflowType,
          {
            ...options,
            taskQueue: laneRoute.taskQueue,
            workflowExecutionTimeout: laneRoute.workflowExecutionTimeout,
          },
          this.shutdownAbort.signal,
        );
      } else {
        await this.temporal.client.workflow.start(workflowType, options);
      }
      this.logger.log(`started ${described}`);
    } catch (err) {
      if ((err as Error)?.name === "WorkflowExecutionAlreadyStartedError") {
        this.logger.log(`${described} already started — merged`);
      } else throw err;
    }
  }

  private async dispatch(ev: {
    eventId: string;
    eventType: string;
    schemaVersion: number;
    workspaceId: string;
    aggregateId: string;
    payload: unknown;
  }): Promise<void> {
    if (ev.eventType === "CompanyProfileCreated") {
      const payload = (ev.payload ?? {}) as {
        website?: string;
        executionBudget?: unknown;
      };
      let executionBudget: ExecutionBudgetBinding;
      try {
        if (ev.schemaVersion !== 2) throw new Error("legacy command version");
        executionBudget = parseExecutionBudgetBinding(payload.executionBudget, {
          scopeKey: ev.workspaceId,
          purpose: "understanding.run",
          subjectType: "company",
        });
      } catch {
        throw new NonRetryableOutboxCommandError(
          "EXECUTION_BUDGET_OUTBOX_COMMAND_PARKED",
        );
      }
      await this.startWorkflowIdempotent(
        UNDERSTANDING_WORKFLOW,
        {
          taskQueue: resolveCustomerTaskQueue("interactive"),
          workflowId: formatTenantWorkflowId(ev.workspaceId, "understanding", ev.aggregateId),
          args: [{ workspaceId: ev.workspaceId, companyId: ev.aggregateId, website: payload.website ?? "", executionContractVersion: 2, executionBudget }],
        },
        `understanding workflow for company ${ev.aggregateId}`,
        ev,
      );
    }
    if (ev.eventType === "DiscoveryRunRequested") {
      const payload = (ev.payload ?? {}) as {
        planId?: string;
        manufacturerNetworkExecution?: unknown;
        icpId?: string;
        executionBudget?: unknown;
      };
      let executionBudget: ExecutionBudgetBinding;
      try {
        if (ev.schemaVersion !== 2) throw new Error("legacy command version");
        executionBudget = parseExecutionBudgetBinding(payload.executionBudget, {
          scopeKey: ev.workspaceId,
          purpose: "discovery.run",
          subjectType: "discovery_run",
        });
      } catch {
        throw new NonRetryableOutboxCommandError(
          "EXECUTION_BUDGET_OUTBOX_COMMAND_PARKED",
        );
      }
      const manufacturerArgs = discoveryManufacturerCommandArguments(payload.manufacturerNetworkExecution, executionBudget, payload.planId);
      await this.startWorkflowIdempotent(
        resolveDiscoveryWorkflowType(),
        {
          taskQueue: resolveCustomerTaskQueue("batch"),
          workflowId: formatTenantWorkflowId(ev.workspaceId, "discovery", ev.aggregateId),
          workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
          workflowExecutionTimeout: DISCOVERY_RUN_EXECUTION_TIMEOUT,
          args: [
            {
              workspaceId: ev.workspaceId,
              runId: ev.aggregateId,
              planId: payload.planId ?? "",
              ...manufacturerArgs,
              icpId: payload.icpId ?? "",
              executionContractVersion: 2,
              executionBudget,
              ...this.discoveryWorkflowKnobs(),
              ...(this.run2QuickScanEnabled() ? { run2QuickScan: true } : {}),
              ...(this.run2ShadowEnabled() ? { run2Shadow: true } : {}),
            },
          ],
        },
        `discovery workflow for run ${ev.aggregateId}`,
        ev,
      );
    }
    if (ev.eventType === "QualifyRequested") {
      await this.startWorkflowIdempotent(
        QUALIFY_WORKFLOW,
        {
          taskQueue: resolveCustomerTaskQueue("batch"),
          workflowId: formatTenantWorkflowId(ev.workspaceId, "qualify", ev.aggregateId),
          args: [qualifyWorkflowArgs(ev)],
        },
        `qualify workflow for icp ${ev.aggregateId}`,
        ev,
      );
    }
    if (
      ev.eventType === "DeletionRequested" ||
      ev.eventType === "SellerDocumentCleanupRequested"
    ) {
      await this.startDeletionCommand(ev);
    }
    if (ev.eventType === "PersonalArtifactCleanupRequested") {
      assertPersonalArtifactCleanupOutboxPayload(ev);
      await this.startWorkflowIdempotent(
        PERSONAL_ARTIFACT_CLEANUP_WORKFLOW,
        {
          taskQueue: resolveCustomerTaskQueue("batch"),
          workflowId: formatTenantWorkflowId(ev.workspaceId, "personal-artifact-cleanup", ev.aggregateId),
          args: [{ workspaceId: ev.workspaceId, deletionRequestId: ev.aggregateId }],
        },
        `personal artifact cleanup for request ${ev.aggregateId}`,
      );
    }
    if (ev.eventType === "AssetObjectCleanupRequested") {
      const command = parseAssetCleanupOutboxCommand(ev);
      await this.startWorkflowIdempotent(
        ASSET_OBJECT_CLEANUP_WORKFLOW,
        {
          taskQueue: resolveCustomerTaskQueue("batch"),
          workflowId: formatTenantWorkflowId(ev.workspaceId, "asset-object-cleanup", ev.eventId),
          args: [command],
        },
        `asset ${command.objectClass} cleanup for event ${ev.eventId}`,
      );
    }
    if (ev.eventType === "LeadRejudgeRequested") await dispatchRejudgeCommand(ev, (w, o, d) => this.startWorkflowIdempotent(w, o, d));
  }
}
