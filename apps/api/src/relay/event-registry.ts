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
  'PersonalArtifactCleanupRequested',
  'AssetObjectCleanupRequested', // R2-A4 staging + MF0-B strict canonical/Variant cleanup
]);

/** 外部集成事件：路由进 outbox_delivery，SaaS 经 GET /events 拉取或 webhook 推送。 */
export const INTEGRATION_EVENTS: ReadonlySet<string> = new Set([
  'LeadQualified',
  'LeadsScored',
  'CandidateBatchCompleted', // M2 步 10：qualify 每批一条（候选 vs 线索分离；运营归因消费）
  'DiscoveryRunCompleted',
  'ICPActivated',
  'ClaimApproved',
  'ClaimRevoked',
  'ClaimExpired',
  'KnowledgeConflictDetected',
  'DeletionCompleted', // 收口⑥ PR-B：擦除完成对外交付事件（🔴 payload 只计数 + subject 引用，无 PII）
  'CampaignPlanJobFailed', // ch08 §3.1.4：失败回写第二通道（控制面 PATCH 重试耗尽后的 outbox 兜底）
  'SanctionsListStale', // ch08 §3.1.12：制裁名单陈旧告警（审计/运营可见；无 PII）
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

export type PayloadEvent = Pick<
  OutboxEventRow,
  | "eventId"
  | "eventType"
  | "schemaVersion"
  | "workspaceId"
  | "aggregateType"
  | "aggregateId"
  | "payload"
>;

const LEAD_QUALIFIED_REQUIRED = [
  "snapshot_version",
  "lead_id",
  "workspace_id",
  "icp_id",
  "icp_version",
  "company_ref",
  "contact_refs",
  "scores",
  "fit_verdict",
  "evidence_refs",
  "qualification_rule_version",
  "storage_rights_decision",
  "personal_data_class",
  "suppression_state",
  "recommended_action",
  "valid_until",
  "sanctions_screening",
] as const;

const CANDIDATE_BATCH_REQUIRED = [
  "run_ref",
  "icp_id",
  "batch_no",
  "batch_ref",
  "scored",
  "queues",
  "candidates",
] as const;

const DELETION_COMPLETED_REQUIRED = [
  "snapshot_version",
  "deletion_request_id",
  "subject_type",
  "subject_ref",
  "contacts_erased",
  "contact_points_erased",
  "field_evidence_erased",
  "signals_revoked",
  "companies_suppressed",
  "leads_rescore_requested",
  "rule_version",
  "erased_at",
] as const;

const ENVELOPE_ONLY_INTEGRATION_EVENTS: ReadonlySet<string> = new Set([
  "LeadsScored",
  "DiscoveryRunCompleted",
  "ICPActivated",
  "ClaimApproved",
  "ClaimRevoked",
  "ClaimExpired",
  "KnowledgeConflictDetected",
  "CampaignPlanJobFailed",
  "SanctionsListStale",
]);

function payloadRecord(ev: PayloadEvent): Record<string, unknown> | null {
  return record(ev.payload);
}

function hasRequiredKeys(
  payload: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return keys.every((key) => Object.prototype.hasOwnProperty.call(payload, key));
}

/** LeadQualified v1/v2 的最小 fail-closed 结构门（完整 schema 见 contracts/events/payloads）。 */
export function matchesLeadQualifiedPayload(ev: PayloadEvent): boolean {
  if (ev.eventType !== "LeadQualified") return true;
  const payload = payloadRecord(ev);
  const companyRef = record(payload?.company_ref);
  return Boolean(
    payload &&
      (ev.schemaVersion === 1 || ev.schemaVersion === 2) &&
      hasRequiredKeys(payload, LEAD_QUALIFIED_REQUIRED) &&
      payload.snapshot_version === ev.schemaVersion &&
      payload.workspace_id === ev.workspaceId &&
      typeof payload.lead_id === "string" &&
      UUID.test(payload.lead_id) &&
      typeof payload.icp_id === "string" &&
      UUID.test(payload.icp_id) &&
      companyRef &&
      typeof companyRef.canonical_company_id === "string" &&
      UUID.test(companyRef.canonical_company_id) &&
      Array.isArray(payload.contact_refs) &&
      record(payload.scores) &&
      record(payload.evidence_refs) &&
      (payload.valid_until === null || typeof payload.valid_until === "string"),
  );
}

/** CandidateBatchCompleted/v1 的最小结构门。 */
export function matchesCandidateBatchCompletedPayload(
  ev: PayloadEvent,
): boolean {
  if (ev.eventType !== "CandidateBatchCompleted") return true;
  const payload = payloadRecord(ev);
  return Boolean(
    payload &&
      ev.schemaVersion === 1 &&
      hasRequiredKeys(payload, CANDIDATE_BATCH_REQUIRED) &&
      (payload.run_ref === null || typeof payload.run_ref === "string") &&
      typeof payload.icp_id === "string" &&
      UUID.test(payload.icp_id) &&
      typeof payload.batch_no === "number" &&
      Number.isSafeInteger(payload.batch_no) &&
      typeof payload.batch_ref === "string" &&
      typeof payload.scored === "number" &&
      Number.isFinite(payload.scored) &&
      record(payload.queues) &&
      Array.isArray(payload.candidates),
  );
}

/**
 * DiscoveryRunCompleted/v1 compatibility validator (WARN-ONLY for now).
 * Historical payloads may omit taskRef/stats/cost/costBasis; status is always written
 * by the producer. Do not require any post-hoc field before the rollout is observed.
 */
export function matchesDiscoveryRunCompletedPayload(ev: PayloadEvent): boolean {
  if (ev.eventType !== "DiscoveryRunCompleted") return true;
  const payload = payloadRecord(ev);
  return Boolean(
    payload &&
      ev.schemaVersion === 1 &&
      typeof payload.status === "string" &&
      payload.status.length > 0 &&
      (payload.planId === undefined || typeof payload.planId === "string") &&
      (payload.stats === undefined || record(payload.stats) !== null) &&
      (payload.cost === undefined || (typeof payload.cost === "number" && Number.isFinite(payload.cost))) &&
      (payload.costBasis === undefined || typeof payload.costBasis === "string") &&
      (payload.taskRef === undefined || record(payload.taskRef) !== null),
  );
}

/**
 * LeadsScored/v1 compatibility validator (WARN-ONLY for now).
 * The historical payload is `{scored, queues}`; it never had a `status` field.
 */
export function matchesLeadsScoredPayload(ev: PayloadEvent): boolean {
  if (ev.eventType !== "LeadsScored") return true;
  const payload = payloadRecord(ev);
  return Boolean(
    payload &&
      ev.schemaVersion === 1 &&
      typeof payload.scored === "number" &&
      Number.isSafeInteger(payload.scored) &&
      payload.scored >= 0 &&
      record(payload.queues) !== null,
  );
}

/** DeletionCompleted/v1 的最小结构门（payload 无 PII，只有计数与引用）。 */
export function matchesDeletionCompletedPayload(ev: PayloadEvent): boolean {
  if (ev.eventType !== "DeletionCompleted") return true;
  const payload = payloadRecord(ev);
  const counts = [
    "contacts_erased",
    "contact_points_erased",
    "field_evidence_erased",
    "signals_revoked",
    "companies_suppressed",
    "leads_rescore_requested",
  ] as const;
  return Boolean(
    payload &&
      ev.schemaVersion === 1 &&
      hasRequiredKeys(payload, DELETION_COMPLETED_REQUIRED) &&
      payload.snapshot_version === 1 &&
      typeof payload.deletion_request_id === "string" &&
      UUID.test(payload.deletion_request_id) &&
      (payload.subject_type === "contact" || payload.subject_type === "company") &&
      typeof payload.subject_ref === "string" &&
      UUID.test(payload.subject_ref) &&
      counts.every(
        (key) =>
          typeof payload[key] === "number" &&
          Number.isSafeInteger(payload[key]) &&
          Number(payload[key]) >= 0,
      ) &&
      typeof payload.rule_version === "string" &&
      typeof payload.erased_at === "string",
  );
}

const INTEGRATION_PAYLOAD_VALIDATORS: Readonly<
  Record<string, (ev: PayloadEvent) => boolean>
> = {
  LeadQualified: matchesLeadQualifiedPayload,
  CandidateBatchCompleted: matchesCandidateBatchCompletedPayload,
  DeletionCompleted: matchesDeletionCompletedPayload,
  SiteBuildCostSummaryUpdated: matchesSiteBuildCostSummaryUpdatedV1,
};

/**
 * 分类一个集成事件的 payload 门：validator（有最小结构门）、envelope-only（显式豁免，
 * 仍要求 payload 是对象）、unclassified（注册了但忘了分类，relay 会 park）。
 */
export function integrationEventValidationClass(
  eventType: string,
): "validator" | "envelope-only" | "unclassified" | "unregistered" {
  if (INTEGRATION_PAYLOAD_VALIDATORS[eventType]) return "validator";
  if (ENVELOPE_ONLY_INTEGRATION_EVENTS.has(eventType)) return "envelope-only";
  if (INTEGRATION_EVENTS.has(eventType)) return "unclassified";
  return "unregistered";
}

/** relay 的集成事件 payload 门：validator 或 envelope-only 对象；未分类 fail closed。 */
export function validateIntegrationEvent(ev: PayloadEvent): boolean {
  const validator = INTEGRATION_PAYLOAD_VALIDATORS[ev.eventType];
  if (validator) return validator(ev);
  if (ENVELOPE_ONLY_INTEGRATION_EVENTS.has(ev.eventType)) {
    return payloadRecord(ev) !== null;
  }
  return false;
}

/**
 * Compatibility validators that are deliberately WARN-ONLY during rollout.
 * They must never park an event or change the consumer; the relay logs a warning.
 */
const WARN_ONLY_INTEGRATION_PAYLOAD_VALIDATORS: Readonly<
  Record<string, (ev: PayloadEvent) => boolean>
> = {
  DiscoveryRunCompleted: matchesDiscoveryRunCompletedPayload,
  LeadsScored: matchesLeadsScoredPayload,
};

export interface IntegrationEventWarning {
  ok: boolean;
  reason?: string;
}

/** Returns null when the event type has no warn-only validator (including envelope-only). */
export function validateIntegrationEventWarnOnly(
  ev: PayloadEvent,
): IntegrationEventWarning | null {
  const validator = WARN_ONLY_INTEGRATION_PAYLOAD_VALIDATORS[ev.eventType];
  if (!validator) return null;
  return validator(ev)
    ? { ok: true }
    : { ok: false, reason: "payload_contract_mismatch" };
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
