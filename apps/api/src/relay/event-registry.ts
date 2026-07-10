/**
 * 事件注册表（收口③）：outbox 事件的**穷举式**分流真值。
 *
 * 为什么要显式注册：旧 relay 对无 handler 的事件「也标 publishedAt」→ 静默丢失（P0）。
 * 现在三分支——internal 拉工作流 / integration 进交付账本 / 未注册 park + 大声报错，
 * 新增事件类型忘记登记会立刻在日志（和 parked 停靠位）上暴露，而不是无声蒸发。
 */

/** 内部命令：relay 消费 → 拉起 Temporal 工作流（不对外交付）。 */
export const INTERNAL_COMMANDS: ReadonlySet<string> = new Set([
  'CompanyProfileCreated',
  'DiscoveryRunRequested',
  'QualifyRequested',
]);

/** 外部集成事件：路由进 outbox_delivery，SaaS 经 GET /events 拉取或 webhook 推送。 */
export const INTEGRATION_EVENTS: ReadonlySet<string> = new Set([
  'LeadQualified',
  'LeadsScored',
  'DiscoveryRunCompleted',
  'ICPActivated',
  'ClaimApproved',
  'ClaimRevoked',
  'ClaimExpired',
  'KnowledgeConflictDetected',
]);

/** pull sink：SaaS 主动 GET /events + POST /events/ack。 */
export const PULL_SINK = 'saas';
/** push sink：SAAS_WEBHOOK_URL 配置时启用（重试 + 退避 + DLQ）。 */
export const WEBHOOK_SINK = 'webhook';

/** relay/GET /events 需要的 outbox_event 行字段（BigInt id 故意不在 envelope 输出里）。 */
export interface OutboxEventRow {
  eventId: string;
  eventType: string;
  schemaVersion: number;
  workspaceId: string;
  aggregateType: string;
  aggregateId: string;
  occurredAt: Date;
  producer: string;
  correlationId: string | null;
  causationId: string | null;
  privacyClassification: string;
  payload: unknown;
}

/** 对外事件信封（packages/contracts/events/envelope.schema.json 的 snake_case 形状）。 */
export interface DomainEventEnvelope {
  event_id: string;
  event_type: string;
  schema_version: number;
  workspace_id: string;
  aggregate_type: string;
  aggregate_id: string;
  occurred_at: string;
  producer: string;
  correlation_id: string | null;
  causation_id: string | null;
  privacy_classification: string;
  payload: Record<string, unknown>;
}

/**
 * outbox 行 → 对外信封（GET /events 与 webhook 推送共用，保证两条通道形状一致）。
 * 消费端 at-least-once，按 event_id 去重（envelope.schema.json 已注明）。
 */
export function toEnvelope(ev: OutboxEventRow): DomainEventEnvelope {
  return {
    event_id: ev.eventId,
    event_type: ev.eventType,
    schema_version: ev.schemaVersion,
    workspace_id: ev.workspaceId,
    aggregate_type: ev.aggregateType,
    aggregate_id: ev.aggregateId,
    occurred_at: ev.occurredAt.toISOString(),
    producer: ev.producer,
    correlation_id: ev.correlationId,
    causation_id: ev.causationId,
    privacy_classification: ev.privacyClassification,
    payload: (ev.payload ?? {}) as Record<string, unknown>,
  };
}
