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
  'DeletionRequested', // 收口⑥ PR-B：relay dispatch → 起 deletionWorkflow（Art.17 擦除编排）
  'AssetObjectCleanupRequested', // R2-A4 staging + MF0-B strict canonical/Variant cleanup
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
  'DeletionCompleted', // 收口⑥ PR-B：擦除完成对外交付事件（🔴 payload 只计数 + subject 引用，无 PII）
  'SiteBuildCostSummaryUpdated', // v1 append-only reconciliation projection for SaaS Credits/Billing
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

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

/** Machine boundary for SiteBuildCostSummaryUpdated/v1 delivery. */
export function matchesSiteBuildCostSummaryUpdatedV1(
  ev: Pick<
    OutboxEventRow,
    | "eventType"
    | "schemaVersion"
    | "workspaceId"
    | "aggregateType"
    | "aggregateId"
    | "payload"
  >,
): boolean {
  if (ev.eventType !== "SiteBuildCostSummaryUpdated") return true;
  const payload = record(ev.payload);
  const budget = record(payload?.budget);
  const totals = record(payload?.totals);
  const reconciliation = record(payload?.reconciliation);
  const decimalFields = (value: Record<string, unknown>, keys: string[]) =>
    keys.every(
      (key) => typeof value[key] === "string" && DECIMAL.test(value[key]),
    );
  return Boolean(
    ev.schemaVersion === 1 &&
      ev.aggregateType === "SiteBuildRun" &&
      UUID.test(ev.workspaceId) &&
      UUID.test(ev.aggregateId) &&
      payload &&
      exactKeys(payload, [
        "workspaceId",
        "siteId",
        "buildRunId",
        "revision",
        "summaryDigest",
        "budget",
        "totals",
        "reconciliation",
      ]) &&
      payload.workspaceId === ev.workspaceId &&
      typeof payload.siteId === "string" &&
      UUID.test(payload.siteId) &&
      payload.buildRunId === ev.aggregateId &&
      Number.isSafeInteger(payload.revision) &&
      Number(payload.revision) >= 0 &&
      typeof payload.summaryDigest === "string" &&
      SHA256.test(payload.summaryDigest) &&
      budget &&
      exactKeys(budget, [
        "authorizedCapMicrousd",
        "conservativeChargedMicrousd",
        "capMicrousd",
        "reservedMicrousd",
        "chargedMicrousd",
        "remainingMicrousd",
        "paidCallsEnabled",
        "disabledReason",
        "exhaustedAt",
      ]) &&
      decimalFields(budget, [
        "authorizedCapMicrousd",
        "conservativeChargedMicrousd",
        "capMicrousd",
        "reservedMicrousd",
        "chargedMicrousd",
        "remainingMicrousd",
      ]) &&
      typeof budget.paidCallsEnabled === "boolean" &&
      (budget.disabledReason === null ||
        typeof budget.disabledReason === "string") &&
      (budget.exhaustedAt === null || typeof budget.exhaustedAt === "string") &&
      totals &&
      exactKeys(totals, [
        "reportedCostMicrousd",
        "calculatedCostMicrousd",
        "estimatedCostMicrousd",
        "unknownOperations",
        "exactCostMicrousd",
        "upperBoundCostMicrousd",
      ]) &&
      decimalFields(totals, [
        "reportedCostMicrousd",
        "calculatedCostMicrousd",
        "estimatedCostMicrousd",
        "exactCostMicrousd",
        "upperBoundCostMicrousd",
      ]) &&
      Number.isSafeInteger(totals.unknownOperations) &&
      Number(totals.unknownOperations) >= 0 &&
      reconciliation &&
      exactKeys(reconciliation, [
        "pendingOperations",
        "resolvedOperations",
        "conflictOperations",
        "asOf",
        "revision",
      ]) &&
      [
        reconciliation.pendingOperations,
        reconciliation.resolvedOperations,
        reconciliation.conflictOperations,
        reconciliation.revision,
      ].every((value) => Number.isSafeInteger(value) && Number(value) >= 0) &&
      reconciliation.revision === payload.revision &&
      (reconciliation.asOf === null ||
        typeof reconciliation.asOf === "string")
  );
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
