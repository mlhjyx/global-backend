import type { ExecutionBudgetPurpose } from "../execution-budget/execution-budget-authority.types";
import {
  ACQ_SWEEP_SCHEDULE_ID,
  INTENT_SWEEP_SCHEDULE_ID,
  PATENTS_CACHE_REFRESH_SCHEDULE_ID,
  SANCTIONS_REFRESH_SCHEDULE_ID,
} from "./understanding.constants";

const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPE_KEYS = [
  "purpose",
  "requestSha256",
  "scheduleId",
  "subjectId",
  "subjectType",
] as const;
const BINDING_KEYS = [
  "accountKey",
  "admissionReplay",
  "authorityId",
  "purpose",
  "requestSha256",
  "scheduleId",
  "scopeKey",
  "subjectId",
  "subjectType",
  "workflowRunId",
] as const;

export const PLATFORM_SCHEDULE_AUTHORITY_CONTRACT_VERSION = 1 as const;
export const PLATFORM_SCHEDULE_AUTHORITY_PATCH =
  "platform-schedule-authority-v1";

export type PlatformScheduleId =
  | typeof ACQ_SWEEP_SCHEDULE_ID
  | typeof INTENT_SWEEP_SCHEDULE_ID
  | typeof SANCTIONS_REFRESH_SCHEDULE_ID
  | typeof PATENTS_CACHE_REFRESH_SCHEDULE_ID;

export interface PlatformScheduleAuthorityScope {
  readonly purpose: Extract<ExecutionBudgetPurpose, `platform.${string}`>;
  readonly subjectType: "schedule";
  readonly subjectId: PlatformScheduleId;
  readonly scheduleId: PlatformScheduleId;
  readonly requestSha256: string;
}

function scope(
  purpose: PlatformScheduleAuthorityScope["purpose"],
  scheduleId: PlatformScheduleId,
  requestSha256: string,
): PlatformScheduleAuthorityScope {
  return Object.freeze({
    purpose,
    subjectType: "schedule",
    subjectId: scheduleId,
    scheduleId,
    requestSha256,
  });
}

export const PLATFORM_SCHEDULE_AUTHORITY_SCOPES = Object.freeze({
  [ACQ_SWEEP_SCHEDULE_ID]: scope(
    "platform.acquisition",
    ACQ_SWEEP_SCHEDULE_ID,
    "5e960ccef72129aa32bdd9464c9d7b546e5ed6dd7a639caad46df77edea3448e",
  ),
  [INTENT_SWEEP_SCHEDULE_ID]: scope(
    "platform.intent_watch",
    INTENT_SWEEP_SCHEDULE_ID,
    "9ef4afce408c36472e00db01a80b6e3a3e461a2b13af7f456d9ce31a7676c34a",
  ),
  [SANCTIONS_REFRESH_SCHEDULE_ID]: scope(
    "platform.sanctions",
    SANCTIONS_REFRESH_SCHEDULE_ID,
    "50b8dfae274bb16a825147c648f46789ea0eb291b3d32964c8bacf385340dffe",
  ),
  [PATENTS_CACHE_REFRESH_SCHEDULE_ID]: scope(
    "platform.acquisition",
    PATENTS_CACHE_REFRESH_SCHEDULE_ID,
    "3fbcd9326937d66243f1395d3f0c4f098c6748977d00ae90017d0f8f04202db6",
  ),
} satisfies Readonly<
  Record<PlatformScheduleId, PlatformScheduleAuthorityScope>
>);

export interface PlatformScheduleWorkflowInput {
  readonly executionContractVersion?: 1;
  readonly executionScope?: PlatformScheduleAuthorityScope;
}

export interface PlatformExecutionBudgetBinding extends PlatformScheduleAuthorityScope {
  readonly authorityId: string;
  readonly scopeKey: "platform";
  readonly accountKey: string;
  readonly workflowRunId: string;
  readonly admissionReplay: boolean;
}

export interface PlatformExecutionBudgetBindingExpectation extends Partial<PlatformScheduleAuthorityScope> {
  readonly workflowRunId?: string;
}

export interface PlatformScheduleAuthorityActivityInput {
  readonly executionContractVersion?: 1;
  readonly executionBudget?: PlatformExecutionBudgetBinding;
}

export class PlatformExecutionBudgetBindingError extends Error {
  readonly code = "PLATFORM_EXECUTION_BUDGET_BINDING_INVALID";

  constructor() {
    super("PLATFORM_EXECUTION_BUDGET_BINDING_INVALID");
    this.name = "PlatformExecutionBudgetBindingError";
  }
}

function invalid(): never {
  throw new PlatformExecutionBudgetBindingError();
}

function boundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    ![...value].some((character) => character.charCodeAt(0) < 32)
  );
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

export function isPlatformScheduleId(
  value: unknown,
): value is PlatformScheduleId {
  return (
    typeof value === "string" &&
    Object.hasOwn(PLATFORM_SCHEDULE_AUTHORITY_SCOPES, value)
  );
}

export function parsePlatformScheduleAuthorityScope(
  value: unknown,
  expectedScheduleId?: PlatformScheduleId,
): PlatformScheduleAuthorityScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (
    !exactKeys(record, SCOPE_KEYS) ||
    !isPlatformScheduleId(record.scheduleId) ||
    !SHA256.test(String(record.requestSha256 ?? ""))
  ) {
    invalid();
  }
  const canonical = PLATFORM_SCHEDULE_AUTHORITY_SCOPES[record.scheduleId];
  if (
    (expectedScheduleId !== undefined &&
      record.scheduleId !== expectedScheduleId) ||
    record.purpose !== canonical.purpose ||
    record.subjectType !== canonical.subjectType ||
    record.subjectId !== canonical.subjectId ||
    record.requestSha256 !== canonical.requestSha256
  ) {
    invalid();
  }
  return canonical;
}

export function platformScheduleWorkflowInput(
  scheduleId: PlatformScheduleId,
): Readonly<Required<PlatformScheduleWorkflowInput>> {
  return Object.freeze({
    executionContractVersion: PLATFORM_SCHEDULE_AUTHORITY_CONTRACT_VERSION,
    executionScope: PLATFORM_SCHEDULE_AUTHORITY_SCOPES[scheduleId],
  });
}

export function platformScheduleAccountKey(
  scopeValue: PlatformScheduleAuthorityScope,
  workflowRunId: string,
): string {
  const parsed = parsePlatformScheduleAuthorityScope(scopeValue);
  if (!boundedText(workflowRunId, 100)) invalid();
  const accountKey = `platform:${parsed.requestSha256}:${workflowRunId}`;
  if (!boundedText(accountKey, 200)) invalid();
  return accountKey;
}

export function parsePlatformExecutionBudgetBinding(
  value: unknown,
  expected: PlatformExecutionBudgetBindingExpectation = {},
): PlatformExecutionBudgetBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (
    !exactKeys(record, BINDING_KEYS) ||
    typeof record.authorityId !== "string" ||
    !UUID.test(record.authorityId) ||
    record.scopeKey !== "platform" ||
    typeof record.admissionReplay !== "boolean" ||
    !boundedText(record.workflowRunId, 100)
  ) {
    invalid();
  }
  const parsedScope = parsePlatformScheduleAuthorityScope({
    purpose: record.purpose,
    requestSha256: record.requestSha256,
    scheduleId: record.scheduleId,
    subjectId: record.subjectId,
    subjectType: record.subjectType,
  });
  const expectedAccountKey = platformScheduleAccountKey(
    parsedScope,
    record.workflowRunId,
  );
  if (
    record.accountKey !== expectedAccountKey ||
    (expected.workflowRunId !== undefined &&
      record.workflowRunId !== expected.workflowRunId) ||
    (expected.purpose !== undefined &&
      parsedScope.purpose !== expected.purpose) ||
    (expected.subjectType !== undefined &&
      parsedScope.subjectType !== expected.subjectType) ||
    (expected.subjectId !== undefined &&
      parsedScope.subjectId !== expected.subjectId) ||
    (expected.scheduleId !== undefined &&
      parsedScope.scheduleId !== expected.scheduleId) ||
    (expected.requestSha256 !== undefined &&
      parsedScope.requestSha256 !== expected.requestSha256)
  ) {
    invalid();
  }
  return Object.freeze({
    authorityId: record.authorityId,
    scopeKey: "platform",
    accountKey: expectedAccountKey,
    ...parsedScope,
    workflowRunId: record.workflowRunId,
    admissionReplay: record.admissionReplay,
  });
}
