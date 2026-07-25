import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import {
  ContractGraphV1,
  RuntimeDifferenceReportV1,
  RuntimeEvidenceBundleV1,
  RuntimeEvidenceDiagnosticV1,
  RuntimeEvidenceV1,
} from "./schema";
import { createEvidence, graphFreshnessDiagnostics, readGraph } from "./scan";
import { sha256, stableJson, uniqueSorted } from "./utils";

const execFile = promisify(execFileCallback);
const OUTPUT_DIRECTORY = ".code-intelligence";
const BUNDLE_FILE = "runtime-evidence-v1.json";
const MANIFEST_FILE = "runtime-evidence-manifest-v1.json";
const DIFFERENCE_FILE = "runtime-difference-v1.json";
const UNKNOWN_COMMIT = "UNKNOWN";
const MAX_RUNTIME_EVIDENCE_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

const SYSTEMD_UNITS = [
  "global-api.service",
  "global-worker.service",
  "temporal-dev.service",
] as const;

const TEMPORAL_SCHEDULE_WORKFLOW_TYPES: Readonly<Record<string, string>> = {
  "acq-sweep": "acquisitionSweepWorkflow",
  "backlog-sweep": "backlogSweepWorkflow",
  "external-intent-sweep": "externalIntentSweepWorkflow",
  "intent-sweep": "intentSweepWorkflow",
  "patents-cache-refresh": "patentsCacheRefreshWorkflow",
  "sanctions-refresh": "sanctionsRefreshWorkflow",
  "site-builder-kb-recovery": "kbRecoverySweepWorkflow",
  "site-builder-release-maintenance": "siteReleaseMaintenanceSweepWorkflow",
};

const TEMPORAL_SCHEDULE_IDS = new Set(
  Object.keys(TEMPORAL_SCHEDULE_WORKFLOW_TYPES),
);

const OUTBOX_EVENT_TYPES = new Set([
  "AssetObjectCleanupRequested",
  "ClaimApproved",
  "ClaimExpired",
  "ClaimRevoked",
  "CompanyProfileCreated",
  "DeletionCompleted",
  "DeletionRequested",
  "DiscoveryRunCompleted",
  "DiscoveryRunRequested",
  "ICPActivated",
  "KnowledgeConflictDetected",
  "LeadQualified",
  "LeadsScored",
  "NotRegisteredEvent",
  "QualifyRequested",
]);

const RUNTIME_RECORD_INPUT_KEYS = new Set([
  "kind",
  "environment",
  "subject",
  "commit",
  "observedAt",
  "sourceObservedAt",
  "graphNodeIds",
  "graphEdgeIds",
  "correlationId",
  "workflowId",
  "workflowRunId",
  "eventId",
  "eventType",
  "migrationId",
  "buildRunId",
  "scheduleId",
  "httpStatus",
  "outcome",
  "durationMs",
  "metadata",
]);

const RUNTIME_RECORD_KEYS = new Set([
  "schemaVersion",
  "id",
  ...RUNTIME_RECORD_INPUT_KEYS,
  "evidenceHash",
]);

const RUNTIME_RECORD_REQUIRED_KEYS = new Set([
  "schemaVersion",
  "id",
  "kind",
  "environment",
  "subject",
  "commit",
  "observedAt",
  "graphNodeIds",
  "graphEdgeIds",
  "outcome",
  "metadata",
  "evidenceHash",
]);

const METADATA_KEYS = new Set([
  "expectedKey",
  "checkPassed",
  "requestIdEchoed",
  "service",
  "activeState",
  "subState",
  "workingDirectory",
  "fragmentPath",
  "processStartedAt",
  "runtimeRevisionProven",
  "state",
  "health",
  "image",
  "composeProject",
  "configurationRoot",
  "configurationFile",
  "serving",
  "address",
  "workflowType",
  "executionStatus",
  "finished",
  "rolledBack",
  "unfinishedCount",
  "database",
  "deliveryState",
  "correlationIdPresent",
  "buildKind",
  "workflowIdentityPersisted",
]);

const BOOLEAN_METADATA_KEYS = new Set([
  "checkPassed",
  "requestIdEchoed",
  "runtimeRevisionProven",
  "serving",
  "finished",
  "rolledBack",
  "correlationIdPresent",
  "workflowIdentityPersisted",
]);

const KIND_METADATA_KEYS: Record<
  RuntimeEvidenceV1["kind"],
  ReadonlySet<string>
> = {
  API_HEALTH: new Set([
    "expectedKey",
    "checkPassed",
    "requestIdEchoed",
    "service",
  ]),
  SYSTEMD_SERVICE: new Set([
    "activeState",
    "subState",
    "workingDirectory",
    "fragmentPath",
    "processStartedAt",
    "runtimeRevisionProven",
  ]),
  COMPOSE_SERVICE: new Set([
    "state",
    "health",
    "image",
    "composeProject",
    "configurationRoot",
    "configurationFile",
    "runtimeRevisionProven",
  ]),
  TEMPORAL_CLUSTER: new Set(["serving", "address", "runtimeRevisionProven"]),
  TEMPORAL_SCHEDULE: new Set([
    "workflowType",
    "executionStatus",
    "runtimeRevisionProven",
  ]),
  OUTBOX_EVENT: new Set([
    "deliveryState",
    "correlationIdPresent",
    "runtimeRevisionProven",
  ]),
  DATABASE_MIGRATION: new Set([
    "finished",
    "rolledBack",
    "unfinishedCount",
    "database",
    "runtimeRevisionProven",
  ]),
  BUILD_RUN: new Set([
    "executionStatus",
    "buildKind",
    "workflowIdentityPersisted",
    "runtimeRevisionProven",
  ]),
};

const ENUM_METADATA_VALUES: Readonly<Record<string, ReadonlySet<string>>> = {
  service: new Set(["global-api"]),
  activeState: new Set([
    "active",
    "inactive",
    "failed",
    "activating",
    "deactivating",
    "reloading",
    "maintenance",
    "UNKNOWN",
  ]),
  subState: new Set([
    "running",
    "exited",
    "dead",
    "failed",
    "start",
    "stop",
    "auto-restart",
    "UNKNOWN",
  ]),
  state: new Set([
    "running",
    "exited",
    "restarting",
    "paused",
    "dead",
    "created",
    "removing",
    "UNKNOWN",
  ]),
  health: new Set([
    "healthy",
    "unhealthy",
    "starting",
    "UNDECLARED",
    "UNKNOWN",
  ]),
  composeProject: new Set(["global"]),
  workflowType: new Set(Object.values(TEMPORAL_SCHEDULE_WORKFLOW_TYPES)),
  executionStatus: new Set([
    "UNKNOWN",
    "queued",
    "running",
    "succeeded",
    "failed",
    "cancelled",
    "WORKFLOW_EXECUTION_STATUS_UNSPECIFIED",
    "WORKFLOW_EXECUTION_STATUS_RUNNING",
    "WORKFLOW_EXECUTION_STATUS_COMPLETED",
    "WORKFLOW_EXECUTION_STATUS_FAILED",
    "WORKFLOW_EXECUTION_STATUS_CANCELED",
    "WORKFLOW_EXECUTION_STATUS_TERMINATED",
    "WORKFLOW_EXECUTION_STATUS_CONTINUED_AS_NEW",
    "WORKFLOW_EXECUTION_STATUS_TIMED_OUT",
  ]),
  database: new Set(["global_dev"]),
  deliveryState: new Set(["PUBLISHED", "PARKED", "PENDING", "UNKNOWN"]),
  buildKind: new Set(["demo_v0", "refurbish"]),
};

const NULLABLE_ENUM_METADATA_KEYS = new Set([
  "service",
  "workflowType",
  "buildKind",
]);

const SAFE_MACHINE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,255}$/;
const SAFE_GRAPH_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,1023}$/;
const SAFE_IMAGE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._/@:+-]{0,511}$/;
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
const RUNTIME_CORRELATION_ID =
  /^runtime-probe-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKFLOW_ID = /^[A-Za-z0-9][A-Za-z0-9._:]*-[A-Za-z0-9._:-]+$/;
const WORKFLOW_RUN_ID =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|run-[A-Za-z0-9._:-]+)$/i;
const EVENT_TYPE = /^[A-Z][A-Za-z0-9.]{2,255}$/;
const MIGRATION_ID = /^\d{14}_[a-z0-9_]{1,240}$/;
const SCHEDULE_ID = /^[a-z0-9][a-z0-9-]{1,127}$/;
const SHA_256 = /^[a-f0-9]{64}$/;
const GIT_COMMIT = /^[a-f0-9]{40}$/;
const FORBIDDEN_VALUE_CONTENT =
  /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:https?|ftp|file|data):\/\/|\b(?:bearer|basic)\s+[A-Za-z0-9._~+/-]+=*|\b(?:sk|rk|pk)-(?:live|test|proj)-[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:secret|token|password|credential|api[_-]?key)\s*[:=]\s*\S+)/i;

const HEALTH_FAILURE_KINDS = new Set<RuntimeEvidenceV1["kind"]>([
  "API_HEALTH",
  "SYSTEMD_SERVICE",
  "COMPOSE_SERVICE",
  "TEMPORAL_CLUSTER",
  "TEMPORAL_SCHEDULE",
  "DATABASE_MIGRATION",
]);

interface CommandResult {
  stdout: string;
  durationMs: number;
}

interface FetchResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  durationMs: number;
}

export interface RuntimeProbeAdapter {
  now(): Date;
  run(file: string, args: string[]): Promise<CommandResult>;
  fetchJson(url: string, headers: Record<string, string>): Promise<FetchResult>;
}

export interface RuntimeRecordInput {
  kind: RuntimeEvidenceV1["kind"];
  environment: RuntimeEvidenceV1["environment"];
  subject: string;
  commit?: string;
  observedAt: string;
  sourceObservedAt?: string;
  graphNodeIds?: string[];
  graphEdgeIds?: string[];
  correlationId?: string;
  workflowId?: string;
  workflowRunId?: string;
  eventId?: string;
  eventType?: string;
  migrationId?: string;
  buildRunId?: string;
  scheduleId?: string;
  httpStatus?: number;
  outcome: RuntimeEvidenceV1["outcome"];
  durationMs?: number;
  metadata?: RuntimeEvidenceV1["metadata"];
}

interface TemporalSchedule {
  scheduleId?: unknown;
  info?: {
    workflowType?: { name?: unknown };
    recentActions?: Array<{
      actualTime?: unknown;
      startWorkflowResult?: {
        workflowId?: unknown;
        runId?: unknown;
      };
      startWorkflowStatus?: unknown;
    }>;
  };
}

interface MigrationRow {
  migrationId?: unknown;
  finishedAt?: unknown;
  rolledBackAt?: unknown;
  unfinishedCount?: unknown;
}

interface OutboxRow {
  eventId?: unknown;
  eventType?: unknown;
  correlationIdPresent?: unknown;
  occurredAt?: unknown;
  deliveryState?: unknown;
}

interface BuildRunRow {
  buildRunId?: unknown;
  status?: unknown;
  kind?: unknown;
  workflowId?: unknown;
  workflowRunId?: unknown;
  createdAt?: unknown;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finiteDuration(value: number | undefined): number | undefined {
  return value != null && Number.isFinite(value) && value >= 0
    ? Math.round(value * 1000) / 1000
    : undefined;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  expected: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => expected.has(key));
}

function hasRequiredKeys(
  value: Record<string, unknown>,
  required: ReadonlySet<string>,
): boolean {
  return [...required].every((key) =>
    Object.prototype.hasOwnProperty.call(value, key),
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: ReadonlySet<string>,
): boolean {
  return (
    Object.keys(value).length === expected.size &&
    hasOnlyKeys(value, expected) &&
    hasRequiredKeys(value, expected)
  );
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function assertSafeString(
  value: string,
  field: string,
  pattern: RegExp = SAFE_MACHINE_IDENTIFIER,
): void {
  const normalized = value.normalize("NFKC");
  if (
    value.length > 512 ||
    normalized !== value ||
    !pattern.test(value) ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    FORBIDDEN_VALUE_CONTENT.test(normalized)
  ) {
    throw new Error(`runtime evidence ${field} is unsafe`);
  }
}

function assertSafePath(value: string, field: string): void {
  const normalized = value.normalize("NFKC");
  if (
    normalized !== value ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    FORBIDDEN_VALUE_CONTENT.test(normalized)
  ) {
    throw new Error(`runtime evidence ${field} is unsafe`);
  }
}

function assertSafeOptionalIdentifier(
  value: string | undefined,
  field: string,
  pattern: RegExp = SAFE_MACHINE_IDENTIFIER,
): void {
  if (value != null) assertSafeString(value, field, pattern);
}

function assertSafeMetadata(metadata: RuntimeEvidenceV1["metadata"]): void {
  for (const [key, value] of Object.entries(metadata)) {
    if (!METADATA_KEYS.has(key)) {
      throw new Error(
        `runtime evidence metadata key is not allowlisted: ${key}`,
      );
    }
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      throw new Error(`runtime evidence metadata value is not scalar: ${key}`);
    }
    if (typeof value === "string" && value.length > 1024) {
      throw new Error(`runtime evidence metadata value is too long: ${key}`);
    }
    if (BOOLEAN_METADATA_KEYS.has(key)) {
      if (typeof value !== "boolean") {
        throw new Error(
          `runtime evidence metadata value type is invalid: ${key}`,
        );
      }
      continue;
    }
    if (key === "unfinishedCount") {
      if (
        value !== null &&
        (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      ) {
        throw new Error(`runtime evidence metadata value is invalid: ${key}`);
      }
      continue;
    }
    if (key === "expectedKey") {
      if (!["status", "db"].includes(String(value))) {
        throw new Error(`runtime evidence metadata value is invalid: ${key}`);
      }
      continue;
    }
    if (
      ["workingDirectory", "fragmentPath", "configurationRoot"].includes(key)
    ) {
      if (value !== null) {
        if (typeof value !== "string") {
          throw new Error(
            `runtime evidence metadata value type is invalid: ${key}`,
          );
        }
        assertSafePath(value, `metadata.${key}`);
        const allowedRoot =
          key === "fragmentPath"
            ? "/etc/systemd/system"
            : key === "workingDirectory"
              ? "/global/backend"
              : "/global";
        if (value !== allowedRoot && !value.startsWith(`${allowedRoot}/`)) {
          throw new Error(
            `runtime evidence metadata path is outside the allowlist: ${key}`,
          );
        }
      }
      continue;
    }
    if (key === "configurationFile") {
      if (value !== null) {
        if (
          typeof value !== "string" ||
          value.split(",").some((file) => {
            try {
              assertSafePath(file, `metadata.${key}`);
              if (!file.startsWith("/global/")) {
                throw new Error("configuration file is outside /global");
              }
              return false;
            } catch {
              return true;
            }
          })
        ) {
          throw new Error(`runtime evidence metadata value is invalid: ${key}`);
        }
      }
      continue;
    }
    if (key === "processStartedAt") {
      if (
        value !== null &&
        (typeof value !== "string" ||
          value.length > 128 ||
          !Number.isFinite(Date.parse(value)) ||
          FORBIDDEN_VALUE_CONTENT.test(value.normalize("NFKC")))
      ) {
        throw new Error(`runtime evidence metadata value is invalid: ${key}`);
      }
      continue;
    }
    if (key === "image") {
      if (value !== null) {
        if (typeof value !== "string") {
          throw new Error(
            `runtime evidence metadata value type is invalid: ${key}`,
          );
        }
        assertSafeString(value, `metadata.${key}`, SAFE_IMAGE_REFERENCE);
      }
      continue;
    }
    if (key === "address") {
      if (value !== "127.0.0.1:7233") {
        throw new Error(`runtime evidence metadata value is invalid: ${key}`);
      }
      continue;
    }
    const enumValues = ENUM_METADATA_VALUES[key];
    if (enumValues) {
      if (value === null) {
        if (!NULLABLE_ENUM_METADATA_KEYS.has(key)) {
          throw new Error(
            `runtime evidence metadata value cannot be null: ${key}`,
          );
        }
      } else {
        if (typeof value !== "string" || !enumValues.has(value)) {
          throw new Error(
            `runtime evidence metadata value is outside the allowlist: ${key}`,
          );
        }
      }
      continue;
    }
    throw new Error(`runtime evidence metadata key has no validator: ${key}`);
  }
}

function assertSubjectForKind(input: RuntimeRecordInput): void {
  const exactSubjects: Partial<
    Record<RuntimeEvidenceV1["kind"], ReadonlySet<string>>
  > = {
    API_HEALTH: new Set(["global-api", "global-api-db"]),
    SYSTEMD_SERVICE: new Set(SYSTEMD_UNITS),
    COMPOSE_SERVICE: new Set([
      "global",
      "postgres",
      "redis",
      "new-api",
      "crawl4ai",
      "searxng",
      "minio",
      "embeddings",
      "docling",
    ]),
    TEMPORAL_CLUSTER: new Set(["temporal-dev"]),
  };
  const exact = exactSubjects[input.kind];
  if (exact && !exact.has(input.subject)) {
    throw new Error(`runtime evidence subject is invalid for ${input.kind}`);
  }
  if (
    input.kind === "TEMPORAL_SCHEDULE" &&
    input.subject !== "schedule-list" &&
    !TEMPORAL_SCHEDULE_IDS.has(input.subject)
  ) {
    throw new Error("runtime evidence schedule subject is invalid");
  }
  if (
    input.kind === "OUTBOX_EVENT" &&
    input.subject !== "latest-outbox-event" &&
    !OUTBOX_EVENT_TYPES.has(input.subject)
  ) {
    throw new Error("runtime evidence Outbox subject is invalid");
  }
  if (
    input.kind === "DATABASE_MIGRATION" &&
    input.subject !== "latest-migration" &&
    !MIGRATION_ID.test(input.subject)
  ) {
    throw new Error("runtime evidence migration subject is invalid");
  }
  if (
    input.kind === "BUILD_RUN" &&
    input.subject !== "latest-build-run" &&
    !UUID.test(input.subject)
  ) {
    throw new Error("runtime evidence build subject is invalid");
  }
}

function assertKindFieldAllowlist(input: RuntimeRecordInput): void {
  const present = new Set(
    [
      ["correlationId", input.correlationId],
      ["workflowId", input.workflowId],
      ["workflowRunId", input.workflowRunId],
      ["eventId", input.eventId],
      ["eventType", input.eventType],
      ["migrationId", input.migrationId],
      ["buildRunId", input.buildRunId],
      ["scheduleId", input.scheduleId],
      ["httpStatus", input.httpStatus],
    ]
      .filter((entry) => entry[1] != null)
      .map((entry) => entry[0] as string),
  );
  const allowed: Record<RuntimeEvidenceV1["kind"], ReadonlySet<string>> = {
    API_HEALTH: new Set(["correlationId", "httpStatus"]),
    SYSTEMD_SERVICE: new Set(),
    COMPOSE_SERVICE: new Set(),
    TEMPORAL_CLUSTER: new Set(),
    TEMPORAL_SCHEDULE: new Set(["workflowId", "workflowRunId", "scheduleId"]),
    OUTBOX_EVENT: new Set(["eventId", "eventType"]),
    DATABASE_MIGRATION: new Set(["migrationId"]),
    BUILD_RUN: new Set(["workflowId", "workflowRunId", "buildRunId"]),
  };
  if ([...present].some((field) => !allowed[input.kind]?.has(field))) {
    throw new Error(
      `runtime evidence contains a field not allowlisted for ${input.kind}`,
    );
  }
}

function assertExactReferences(
  actual: string[] | undefined,
  expected: string[],
  field: "graphNodeIds" | "graphEdgeIds",
): void {
  const values = actual ?? [];
  if (
    new Set(values).size !== values.length ||
    stableJson(uniqueSorted(values)) !== stableJson(uniqueSorted(expected))
  ) {
    throw new Error(
      `runtime evidence ${field} do not match the ${field} contract`,
    );
  }
}

function expectedGraphNodeIds(
  input: RuntimeRecordInput,
  metadata: RuntimeEvidenceV1["metadata"],
): string[] {
  switch (input.kind) {
    case "API_HEALTH":
      return [
        input.subject === "global-api"
          ? "api:GET:/health"
          : "api:GET:/health/db",
      ];
    case "SYSTEMD_SERVICE":
      return [`service:systemd:${input.subject}`];
    case "COMPOSE_SERVICE":
      return input.subject === "global"
        ? []
        : [`service:compose:${input.subject}`];
    case "TEMPORAL_CLUSTER":
      return ["service:systemd:temporal-dev.service"];
    case "TEMPORAL_SCHEDULE": {
      if (input.subject === "schedule-list") return [];
      return [
        `service:temporal-schedule:${input.subject}`,
        `workflow:temporal:${String(metadata.workflowType)}`,
      ];
    }
    case "OUTBOX_EVENT":
      return input.subject === "latest-outbox-event"
        ? []
        : [`event:outbox:${input.subject}`];
    case "DATABASE_MIGRATION":
      return input.subject === "latest-migration"
        ? []
        : [`migration:${input.subject}`];
    case "BUILD_RUN": {
      const workflowNode = buildWorkflowNode(
        typeof metadata.buildKind === "string" ? metadata.buildKind : undefined,
      );
      return [
        "data-model:prisma:SiteBuildRun",
        ...(workflowNode ? [workflowNode] : []),
      ];
    }
  }
}

function assertRuntimeGraphBindings(
  input: RuntimeRecordInput,
  metadata: RuntimeEvidenceV1["metadata"],
): void {
  assertExactReferences(
    input.graphNodeIds,
    expectedGraphNodeIds(input, metadata),
    "graphNodeIds",
  );
  if (input.kind === "TEMPORAL_SCHEDULE" && input.subject !== "schedule-list") {
    if (
      input.graphEdgeIds == null ||
      input.graphEdgeIds.length !== 1 ||
      new Set(input.graphEdgeIds).size !== 1
    ) {
      throw new Error(
        "runtime evidence graphEdgeIds do not match the Temporal Schedule contract",
      );
    }
    return;
  }
  assertExactReferences(input.graphEdgeIds, [], "graphEdgeIds");
}

function assertRuntimeSemantics(
  input: RuntimeRecordInput,
  metadata: RuntimeEvidenceV1["metadata"],
): void {
  const reject = (): never => {
    throw new Error(
      `runtime evidence outcome disagrees with ${input.kind} status metadata`,
    );
  };
  switch (input.kind) {
    case "API_HEALTH":
      if (
        input.outcome !==
        (input.httpStatus === 200 && metadata.checkPassed === true
          ? "SUCCESS"
          : "FAILURE")
      ) {
        reject();
      }
      if (
        input.subject === "global-api" &&
        input.outcome === "SUCCESS" &&
        input.sourceObservedAt == null
      ) {
        reject();
      }
      return;
    case "SYSTEMD_SERVICE": {
      const expected =
        metadata.activeState === "active" && metadata.subState === "running"
          ? "SUCCESS"
          : "FAILURE";
      if (
        input.outcome !== expected ||
        (expected === "SUCCESS" && metadata.processStartedAt == null)
      ) {
        reject();
      }
      return;
    }
    case "COMPOSE_SERVICE": {
      if (input.subject === "global") {
        if (
          input.outcome !== "FAILURE" ||
          metadata.state !== "UNKNOWN" ||
          metadata.health !== "UNKNOWN"
        ) {
          reject();
        }
        return;
      }
      const state = metadata.state;
      const health = metadata.health;
      const expected =
        state !== "running" || health === "unhealthy" || health === "starting"
          ? "FAILURE"
          : health === "healthy"
            ? "SUCCESS"
            : "UNKNOWN";
      if (input.outcome !== expected) reject();
      return;
    }
    case "TEMPORAL_CLUSTER":
      if (
        input.outcome !== (metadata.serving === true ? "SUCCESS" : "FAILURE")
      ) {
        reject();
      }
      return;
    case "TEMPORAL_SCHEDULE": {
      if (input.subject === "schedule-list") {
        if (
          input.outcome !== "FAILURE" ||
          metadata.workflowType !== null ||
          metadata.executionStatus !== "UNKNOWN" ||
          input.workflowId != null ||
          input.workflowRunId != null ||
          input.scheduleId != null ||
          input.sourceObservedAt != null
        ) {
          reject();
        }
        return;
      }
      const expected = temporalOutcome(String(metadata.executionStatus));
      if (input.outcome !== expected) reject();
      if (
        expected !== "UNKNOWN" &&
        (input.workflowId == null ||
          input.workflowRunId == null ||
          input.sourceObservedAt == null)
      ) {
        reject();
      }
      return;
    }
    case "OUTBOX_EVENT": {
      if (input.subject === "latest-outbox-event") {
        if (
          input.outcome !== "FAILURE" ||
          metadata.deliveryState !== "UNKNOWN" ||
          input.eventId != null ||
          input.eventType != null ||
          input.sourceObservedAt != null
        ) {
          reject();
        }
        return;
      }
      const expected =
        metadata.deliveryState === "PUBLISHED"
          ? "SUCCESS"
          : metadata.deliveryState === "PARKED"
            ? "FAILURE"
            : "UNKNOWN";
      if (
        input.outcome !== expected ||
        input.eventId == null ||
        input.eventType == null ||
        input.sourceObservedAt == null
      ) {
        reject();
      }
      return;
    }
    case "DATABASE_MIGRATION": {
      if (input.subject === "latest-migration") {
        if (
          input.outcome !== "FAILURE" ||
          metadata.finished !== false ||
          metadata.rolledBack !== false ||
          metadata.unfinishedCount !== null ||
          input.migrationId != null ||
          input.sourceObservedAt != null
        ) {
          reject();
        }
        return;
      }
      const expected =
        metadata.finished === true &&
        metadata.rolledBack === false &&
        metadata.unfinishedCount === 0
          ? "SUCCESS"
          : "FAILURE";
      if (
        input.outcome !== expected ||
        input.migrationId == null ||
        (expected === "SUCCESS" && input.sourceObservedAt == null)
      ) {
        reject();
      }
      return;
    }
    case "BUILD_RUN": {
      if (input.subject === "latest-build-run") {
        if (
          input.outcome !== "FAILURE" ||
          metadata.executionStatus !== "UNKNOWN" ||
          metadata.buildKind !== null ||
          metadata.workflowIdentityPersisted !== false ||
          input.buildRunId != null ||
          input.workflowId != null ||
          input.workflowRunId != null ||
          input.sourceObservedAt != null
        ) {
          reject();
        }
        return;
      }
      const expected =
        metadata.executionStatus === "succeeded"
          ? "SUCCESS"
          : metadata.executionStatus === "failed" ||
              metadata.executionStatus === "cancelled"
            ? "FAILURE"
            : "UNKNOWN";
      const workflowIdentityPersisted = input.workflowId != null;
      if (
        input.outcome !== expected ||
        input.buildRunId == null ||
        input.sourceObservedAt == null ||
        metadata.workflowIdentityPersisted !== workflowIdentityPersisted ||
        (input.workflowRunId != null && input.workflowId == null)
      ) {
        reject();
      }
      return;
    }
  }
}

function assertRuntimeRecordFields(
  input: RuntimeRecordInput,
  inputKeys: ReadonlySet<string> = RUNTIME_RECORD_INPUT_KEYS,
): void {
  if (!hasOnlyKeys(input as unknown as Record<string, unknown>, inputKeys)) {
    throw new Error("runtime evidence record contains unknown fields");
  }
  if (
    ![
      "API_HEALTH",
      "SYSTEMD_SERVICE",
      "COMPOSE_SERVICE",
      "TEMPORAL_CLUSTER",
      "TEMPORAL_SCHEDULE",
      "OUTBOX_EVENT",
      "DATABASE_MIGRATION",
      "BUILD_RUN",
    ].includes(input.kind) ||
    !["development", "preproduction"].includes(input.environment) ||
    !isIsoTimestamp(input.observedAt) ||
    (input.sourceObservedAt != null &&
      !isIsoTimestamp(input.sourceObservedAt)) ||
    !["SUCCESS", "FAILURE", "UNKNOWN"].includes(input.outcome)
  ) {
    throw new Error("runtime evidence record schema is invalid");
  }
  assertSafeString(input.subject, "subject");
  assertSubjectForKind(input);
  assertKindFieldAllowlist(input);
  if (
    input.commit !== undefined &&
    (typeof input.commit !== "string" ||
      (input.commit !== UNKNOWN_COMMIT && !GIT_COMMIT.test(input.commit)))
  ) {
    throw new Error("runtime evidence commit is invalid");
  }
  for (const [field, values] of [
    ["graphNodeIds", input.graphNodeIds ?? []],
    ["graphEdgeIds", input.graphEdgeIds ?? []],
  ] as const) {
    for (const value of values) {
      assertSafeString(value, field, SAFE_GRAPH_REFERENCE);
    }
  }
  assertSafeOptionalIdentifier(
    input.correlationId,
    "correlationId",
    RUNTIME_CORRELATION_ID,
  );
  assertSafeOptionalIdentifier(input.workflowId, "workflowId", WORKFLOW_ID);
  assertSafeOptionalIdentifier(
    input.workflowRunId,
    "workflowRunId",
    WORKFLOW_RUN_ID,
  );
  assertSafeOptionalIdentifier(input.eventId, "eventId", UUID);
  assertSafeOptionalIdentifier(input.eventType, "eventType", EVENT_TYPE);
  if (input.eventType != null && !OUTBOX_EVENT_TYPES.has(input.eventType)) {
    throw new Error("runtime evidence eventType is outside the contract");
  }
  assertSafeOptionalIdentifier(input.migrationId, "migrationId", MIGRATION_ID);
  assertSafeOptionalIdentifier(input.buildRunId, "buildRunId", UUID);
  assertSafeOptionalIdentifier(input.scheduleId, "scheduleId", SCHEDULE_ID);
  if (
    input.scheduleId != null &&
    !TEMPORAL_SCHEDULE_IDS.has(input.scheduleId)
  ) {
    throw new Error("runtime evidence scheduleId is outside the contract");
  }
  if (
    input.httpStatus != null &&
    (!Number.isInteger(input.httpStatus) ||
      input.httpStatus < 100 ||
      input.httpStatus > 599)
  ) {
    throw new Error("runtime evidence HTTP status is invalid");
  }
  if (
    input.durationMs != null &&
    (!Number.isFinite(input.durationMs) || input.durationMs < 0)
  ) {
    throw new Error("runtime evidence duration is invalid");
  }
  const metadata = input.metadata ?? {};
  assertSafeMetadata(metadata);
  if (!hasExactKeys(metadata, KIND_METADATA_KEYS[input.kind])) {
    throw new Error(
      `runtime evidence metadata fields do not match the ${input.kind} allowlist`,
    );
  }
  const apiIdentityMismatch =
    input.kind === "API_HEALTH" &&
    ((input.subject === "global-api" &&
      (metadata.expectedKey !== "status" ||
        (input.outcome === "SUCCESS"
          ? metadata.service !== "global-api"
          : metadata.service !== null && metadata.service !== "global-api"))) ||
      (input.subject === "global-api-db" &&
        (metadata.expectedKey !== "db" || metadata.service !== null)));
  if (apiIdentityMismatch) {
    throw new Error("runtime evidence API subject and metadata disagree");
  }
  if (
    input.kind === "TEMPORAL_SCHEDULE" &&
    input.subject !== "schedule-list" &&
    (input.scheduleId !== input.subject ||
      metadata.workflowType !== TEMPORAL_SCHEDULE_WORKFLOW_TYPES[input.subject])
  ) {
    throw new Error("runtime evidence schedule identity is inconsistent");
  }
  if (
    input.kind === "OUTBOX_EVENT" &&
    input.subject !== "latest-outbox-event" &&
    input.eventType !== input.subject
  ) {
    throw new Error("runtime evidence Outbox identity is inconsistent");
  }
  if (
    input.kind === "DATABASE_MIGRATION" &&
    input.subject !== "latest-migration" &&
    input.migrationId !== input.subject
  ) {
    throw new Error("runtime evidence migration identity is inconsistent");
  }
  if (
    input.kind === "BUILD_RUN" &&
    input.subject !== "latest-build-run" &&
    input.buildRunId !== input.subject
  ) {
    throw new Error("runtime evidence build identity is inconsistent");
  }
  assertRuntimeGraphBindings(input, metadata);
  assertRuntimeSemantics(input, metadata);
}

export function createRuntimeRecord(
  input: RuntimeRecordInput,
): RuntimeEvidenceV1 {
  assertRuntimeRecordFields(input);
  const metadata = input.metadata ?? {};
  const core = {
    schemaVersion: "runtime-evidence/v1" as const,
    kind: input.kind,
    environment: input.environment,
    subject: input.subject,
    commit: input.commit ?? UNKNOWN_COMMIT,
    observedAt: input.observedAt,
    ...(input.sourceObservedAt
      ? { sourceObservedAt: input.sourceObservedAt }
      : {}),
    graphNodeIds: uniqueSorted(input.graphNodeIds ?? []),
    graphEdgeIds: uniqueSorted(input.graphEdgeIds ?? []),
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    ...(input.workflowId ? { workflowId: input.workflowId } : {}),
    ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
    ...(input.eventId ? { eventId: input.eventId } : {}),
    ...(input.eventType ? { eventType: input.eventType } : {}),
    ...(input.migrationId ? { migrationId: input.migrationId } : {}),
    ...(input.buildRunId ? { buildRunId: input.buildRunId } : {}),
    ...(input.scheduleId ? { scheduleId: input.scheduleId } : {}),
    ...(input.httpStatus != null ? { httpStatus: input.httpStatus } : {}),
    outcome: input.outcome,
    ...(finiteDuration(input.durationMs) != null
      ? { durationMs: finiteDuration(input.durationMs) }
      : {}),
    metadata,
  };
  const id = `runtime:${input.kind.toLowerCase()}:${sha256(stableJson(core)).slice(0, 20)}`;
  return {
    ...core,
    id,
    evidenceHash: sha256(stableJson({ ...core, id })),
  };
}

function verifyRuntimeRecord(record: RuntimeEvidenceV1): boolean {
  try {
    if (
      !hasRequiredKeys(
        record as unknown as Record<string, unknown>,
        RUNTIME_RECORD_REQUIRED_KEYS,
      ) ||
      !hasOnlyKeys(
        record as unknown as Record<string, unknown>,
        RUNTIME_RECORD_KEYS,
      ) ||
      record.schemaVersion !== "runtime-evidence/v1" ||
      !record.id.startsWith("runtime:") ||
      !Array.isArray(record.graphNodeIds) ||
      !Array.isArray(record.graphEdgeIds) ||
      !record.metadata ||
      typeof record.metadata !== "object" ||
      !SHA_256.test(record.evidenceHash)
    ) {
      return false;
    }
    const {
      schemaVersion: _schemaVersion,
      id,
      evidenceHash,
      ...input
    } = record;
    assertRuntimeRecordFields(input, RUNTIME_RECORD_INPUT_KEYS);
    const expectedId = `runtime:${record.kind.toLowerCase()}:${sha256(
      stableJson({ schemaVersion: record.schemaVersion, ...input }),
    ).slice(0, 20)}`;
    return (
      id === expectedId &&
      evidenceHash ===
        sha256(
          stableJson({ schemaVersion: record.schemaVersion, id, ...input }),
        )
    );
  } catch {
    return false;
  }
}

function defaultAdapter(): RuntimeProbeAdapter {
  return {
    now: () => new Date(),
    run: async (file, args) => {
      const started = performance.now();
      const { stdout } = await execFile(file, args, {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 15_000,
      });
      return {
        stdout,
        durationMs: performance.now() - started,
      };
    },
    fetchJson: async (url, headers) => {
      const parsed = new URL(url);
      if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
        throw new Error(
          "runtime evidence HTTP probes are restricted to loopback",
        );
      }
      const started = performance.now();
      const response = await fetch(parsed, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(5_000),
      });
      const body = (await response.json()) as unknown;
      return {
        status: response.status,
        headers: {
          "x-request-id": response.headers.get("x-request-id") ?? "",
        },
        body,
        durationMs: performance.now() - started,
      };
    },
  };
}

function graphEdgeIds(
  graph: ContractGraphV1,
  from: string,
  to: string,
  kind: string,
): string[] {
  return graph.edges
    .filter(
      (edge) => edge.from === from && edge.to === to && edge.kind === kind,
    )
    .map((edge) => edge.id);
}

async function probeApi(
  adapter: RuntimeProbeAdapter,
  environment: RuntimeEvidenceV1["environment"],
  observedAt: string,
  url: string,
  subject: string,
  graphNodeId: string,
  expectedKey: "status" | "db",
): Promise<RuntimeEvidenceV1> {
  const requestId = `runtime-probe-${randomUUID()}`;
  try {
    const response = await adapter.fetchJson(url, {
      "x-request-id": requestId,
    });
    const body =
      response.body && typeof response.body === "object"
        ? (response.body as Record<string, unknown>)
        : {};
    const service = text(body.service);
    const expected =
      body[expectedKey] === "ok" &&
      (expectedKey === "db" || service === "global-api");
    const echoed = text(response.headers["x-request-id"]);
    return createRuntimeRecord({
      kind: "API_HEALTH",
      environment,
      subject,
      observedAt,
      sourceObservedAt: expectedKey === "status" ? text(body.ts) : undefined,
      graphNodeIds: [graphNodeId],
      correlationId: echoed === requestId ? echoed : undefined,
      httpStatus: response.status,
      outcome: response.status === 200 && expected ? "SUCCESS" : "FAILURE",
      durationMs: response.durationMs,
      metadata: {
        expectedKey,
        checkPassed: expected,
        requestIdEchoed: echoed === requestId,
        service: expectedKey === "status" ? (service ?? null) : null,
      },
    });
  } catch {
    return createRuntimeRecord({
      kind: "API_HEALTH",
      environment,
      subject,
      observedAt,
      graphNodeIds: [graphNodeId],
      outcome: "FAILURE",
      metadata: {
        expectedKey,
        checkPassed: false,
        requestIdEchoed: false,
        service: null,
      },
    });
  }
}

function parseProperties(value: string): Record<string, string> {
  return Object.fromEntries(
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return separator < 0
          ? [line, ""]
          : [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

async function probeSystemd(
  adapter: RuntimeProbeAdapter,
  environment: RuntimeEvidenceV1["environment"],
  observedAt: string,
): Promise<RuntimeEvidenceV1[]> {
  return Promise.all(
    SYSTEMD_UNITS.map(async (unit) => {
      try {
        const result = await adapter.run("systemctl", [
          "show",
          unit,
          "--property=Id",
          "--property=ActiveState",
          "--property=SubState",
          "--property=WorkingDirectory",
          "--property=ExecMainStartTimestamp",
          "--property=FragmentPath",
        ]);
        const properties = parseProperties(result.stdout);
        const active =
          properties.ActiveState === "active" &&
          properties.SubState === "running";
        return createRuntimeRecord({
          kind: "SYSTEMD_SERVICE",
          environment,
          subject: unit,
          observedAt,
          graphNodeIds: [`service:systemd:${unit}`],
          outcome: active ? "SUCCESS" : "FAILURE",
          durationMs: result.durationMs,
          metadata: {
            activeState: properties.ActiveState ?? "UNKNOWN",
            subState: properties.SubState ?? "UNKNOWN",
            workingDirectory: properties.WorkingDirectory || null,
            fragmentPath: properties.FragmentPath || null,
            processStartedAt: properties.ExecMainStartTimestamp || null,
            runtimeRevisionProven: false,
          },
        });
      } catch {
        return createRuntimeRecord({
          kind: "SYSTEMD_SERVICE",
          environment,
          subject: unit,
          observedAt,
          graphNodeIds: [`service:systemd:${unit}`],
          outcome: "FAILURE",
          metadata: {
            activeState: "UNKNOWN",
            subState: "UNKNOWN",
            workingDirectory: null,
            fragmentPath: null,
            processStartedAt: null,
            runtimeRevisionProven: false,
          },
        });
      }
    }),
  );
}

function parseComposeRows(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function composeLabel(labels: unknown, key: string): string | undefined {
  if (typeof labels !== "string") return undefined;
  const prefix = `${key}=`;
  return labels
    .split(",")
    .find((entry) => entry.startsWith(prefix))
    ?.slice(prefix.length);
}

async function probeCompose(
  adapter: RuntimeProbeAdapter,
  environment: RuntimeEvidenceV1["environment"],
  observedAt: string,
): Promise<RuntimeEvidenceV1[]> {
  try {
    const result = await adapter.run("docker", [
      "compose",
      "-p",
      "global",
      "ps",
      "--format",
      "json",
    ]);
    return parseComposeRows(result.stdout).map((row) => {
      const service = text(row.Service) ?? "UNKNOWN";
      const state = text(row.State) ?? "UNKNOWN";
      const health = text(row.Health) ?? "UNDECLARED";
      return createRuntimeRecord({
        kind: "COMPOSE_SERVICE",
        environment,
        subject: service,
        observedAt,
        graphNodeIds: [`service:compose:${service}`],
        outcome:
          state !== "running" || ["unhealthy", "starting"].includes(health)
            ? "FAILURE"
            : health === "healthy"
              ? "SUCCESS"
              : "UNKNOWN",
        durationMs: result.durationMs,
        metadata: {
          state,
          health,
          image: text(row.Image) ?? null,
          composeProject: text(row.Project) ?? null,
          configurationRoot:
            composeLabel(
              row.Labels,
              "com.docker.compose.project.working_dir",
            ) ?? null,
          configurationFile:
            composeLabel(
              row.Labels,
              "com.docker.compose.project.config_files",
            ) ?? null,
          runtimeRevisionProven: false,
        },
      });
    });
  } catch {
    return [
      createRuntimeRecord({
        kind: "COMPOSE_SERVICE",
        environment,
        subject: "global",
        observedAt,
        outcome: "FAILURE",
        metadata: {
          state: "UNKNOWN",
          health: "UNKNOWN",
          image: null,
          composeProject: "global",
          configurationRoot: null,
          configurationFile: null,
          runtimeRevisionProven: false,
        },
      }),
    ];
  }
}

async function probeTemporalCluster(
  adapter: RuntimeProbeAdapter,
  environment: RuntimeEvidenceV1["environment"],
  observedAt: string,
): Promise<RuntimeEvidenceV1> {
  try {
    const result = await adapter.run("temporal", [
      "operator",
      "cluster",
      "health",
      "--address",
      "127.0.0.1:7233",
    ]);
    const serving = result.stdout.trim() === "SERVING";
    return createRuntimeRecord({
      kind: "TEMPORAL_CLUSTER",
      environment,
      subject: "temporal-dev",
      observedAt,
      graphNodeIds: ["service:systemd:temporal-dev.service"],
      outcome: serving ? "SUCCESS" : "FAILURE",
      durationMs: result.durationMs,
      metadata: {
        serving,
        address: "127.0.0.1:7233",
        runtimeRevisionProven: false,
      },
    });
  } catch {
    return createRuntimeRecord({
      kind: "TEMPORAL_CLUSTER",
      environment,
      subject: "temporal-dev",
      observedAt,
      graphNodeIds: ["service:systemd:temporal-dev.service"],
      outcome: "FAILURE",
      metadata: {
        serving: false,
        address: "127.0.0.1:7233",
        runtimeRevisionProven: false,
      },
    });
  }
}

function temporalOutcome(
  status: string | undefined,
): RuntimeEvidenceV1["outcome"] {
  if (!status) return "UNKNOWN";
  if (/(?:COMPLETED|RUNNING)$/.test(status)) return "SUCCESS";
  if (/(?:FAILED|CANCELED|TERMINATED|TIMED_OUT)$/.test(status)) {
    return "FAILURE";
  }
  return "UNKNOWN";
}

async function probeTemporalSchedules(
  adapter: RuntimeProbeAdapter,
  graph: ContractGraphV1,
  environment: RuntimeEvidenceV1["environment"],
  observedAt: string,
): Promise<RuntimeEvidenceV1[]> {
  try {
    const result = await adapter.run("temporal", [
      "schedule",
      "list",
      "--address",
      "127.0.0.1:7233",
      "--output",
      "json",
    ]);
    const schedules = JSON.parse(result.stdout) as TemporalSchedule[];
    return schedules.map((schedule) => {
      const scheduleId = text(schedule.scheduleId) ?? "UNKNOWN";
      const workflowType = text(schedule.info?.workflowType?.name);
      const recent = schedule.info?.recentActions?.at(-1);
      const status = text(recent?.startWorkflowStatus);
      const scheduleNode = `service:temporal-schedule:${scheduleId}`;
      const workflowNode = workflowType
        ? `workflow:temporal:${workflowType}`
        : undefined;
      return createRuntimeRecord({
        kind: "TEMPORAL_SCHEDULE",
        environment,
        subject: scheduleId,
        observedAt,
        sourceObservedAt: text(recent?.actualTime),
        graphNodeIds: [scheduleNode, workflowNode].filter(
          (value): value is string => value != null,
        ),
        graphEdgeIds: workflowNode
          ? graphEdgeIds(graph, scheduleNode, workflowNode, "calls")
          : [],
        workflowId: text(recent?.startWorkflowResult?.workflowId),
        workflowRunId: text(recent?.startWorkflowResult?.runId),
        scheduleId,
        outcome: temporalOutcome(status),
        durationMs: result.durationMs,
        metadata: {
          workflowType: workflowType ?? null,
          executionStatus: status ?? "UNKNOWN",
          runtimeRevisionProven: false,
        },
      });
    });
  } catch {
    return [
      createRuntimeRecord({
        kind: "TEMPORAL_SCHEDULE",
        environment,
        subject: "schedule-list",
        observedAt,
        outcome: "FAILURE",
        metadata: {
          workflowType: null,
          executionStatus: "UNKNOWN",
          runtimeRevisionProven: false,
        },
      }),
    ];
  }
}

async function psqlJson<T>(
  adapter: RuntimeProbeAdapter,
  sql: string,
): Promise<{ value?: T; durationMs?: number }> {
  try {
    const result = await adapter.run("docker", [
      "exec",
      "global-postgres",
      "psql",
      "-U",
      "global",
      "-d",
      "global_dev",
      "-At",
      "-c",
      sql,
    ]);
    const line = result.stdout.trim();
    return {
      value: line ? (JSON.parse(line) as T) : undefined,
      durationMs: result.durationMs,
    };
  } catch {
    return {};
  }
}

async function probeMigration(
  adapter: RuntimeProbeAdapter,
  environment: RuntimeEvidenceV1["environment"],
  observedAt: string,
): Promise<RuntimeEvidenceV1> {
  const query = await psqlJson<MigrationRow>(
    adapter,
    `SELECT json_build_object('migrationId', migration_name, 'finishedAt', finished_at, 'rolledBackAt', rolled_back_at, 'unfinishedCount', (SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL))::text FROM _prisma_migrations ORDER BY started_at DESC LIMIT 1`,
  );
  const migrationId = text(query.value?.migrationId);
  const finishedAt = text(query.value?.finishedAt);
  const rolledBackAt = text(query.value?.rolledBackAt);
  const unfinishedCount =
    typeof query.value?.unfinishedCount === "number"
      ? query.value.unfinishedCount
      : Number(query.value?.unfinishedCount ?? Number.NaN);
  try {
    return createRuntimeRecord({
      kind: "DATABASE_MIGRATION",
      environment,
      subject: migrationId ?? "latest-migration",
      observedAt,
      sourceObservedAt: finishedAt,
      graphNodeIds: migrationId ? [`migration:${migrationId}`] : [],
      migrationId,
      outcome:
        migrationId && finishedAt && !rolledBackAt && unfinishedCount === 0
          ? "SUCCESS"
          : "FAILURE",
      durationMs: query.durationMs,
      metadata: {
        finished: Boolean(finishedAt),
        rolledBack: Boolean(rolledBackAt),
        unfinishedCount: Number.isFinite(unfinishedCount)
          ? unfinishedCount
          : null,
        database: "global_dev",
        runtimeRevisionProven: false,
      },
    });
  } catch {
    return createRuntimeRecord({
      kind: "DATABASE_MIGRATION",
      environment,
      subject: "latest-migration",
      observedAt,
      outcome: "FAILURE",
      durationMs: query.durationMs,
      metadata: {
        finished: false,
        rolledBack: false,
        unfinishedCount: null,
        database: "global_dev",
        runtimeRevisionProven: false,
      },
    });
  }
}

async function probeOutbox(
  adapter: RuntimeProbeAdapter,
  environment: RuntimeEvidenceV1["environment"],
  observedAt: string,
): Promise<RuntimeEvidenceV1> {
  const query = await psqlJson<OutboxRow>(
    adapter,
    `SELECT json_build_object('eventId', event_id, 'eventType', event_type, 'correlationIdPresent', correlation_id IS NOT NULL, 'occurredAt', occurred_at, 'deliveryState', CASE WHEN published_at IS NOT NULL THEN 'PUBLISHED' WHEN parked_at IS NOT NULL THEN 'PARKED' ELSE 'PENDING' END)::text FROM outbox_event ORDER BY occurred_at DESC LIMIT 1`,
  );
  const eventId = text(query.value?.eventId);
  const eventType = text(query.value?.eventType);
  const deliveryState = text(query.value?.deliveryState) ?? "UNKNOWN";
  const eventNode = eventType ? `event:outbox:${eventType}` : undefined;
  try {
    return createRuntimeRecord({
      kind: "OUTBOX_EVENT",
      environment,
      subject: eventType ?? "latest-outbox-event",
      observedAt,
      sourceObservedAt: text(query.value?.occurredAt),
      graphNodeIds: eventNode ? [eventNode] : [],
      // Existence proves the event type occurred, not that a static consumer ran.
      graphEdgeIds: [],
      eventId,
      eventType,
      outcome:
        deliveryState === "PUBLISHED"
          ? "SUCCESS"
          : deliveryState === "PARKED"
            ? "FAILURE"
            : "UNKNOWN",
      durationMs: query.durationMs,
      metadata: {
        deliveryState,
        correlationIdPresent: query.value?.correlationIdPresent === true,
        runtimeRevisionProven: false,
      },
    });
  } catch {
    return createRuntimeRecord({
      kind: "OUTBOX_EVENT",
      environment,
      subject: "latest-outbox-event",
      observedAt,
      outcome: "FAILURE",
      durationMs: query.durationMs,
      metadata: {
        deliveryState: "UNKNOWN",
        correlationIdPresent: query.value?.correlationIdPresent === true,
        runtimeRevisionProven: false,
      },
    });
  }
}

function buildWorkflowNode(kind: string | undefined): string | undefined {
  if (kind === "refurbish") return "workflow:temporal:refurbishWorkflow";
  if (kind === "demo_v0") return "workflow:temporal:demoV0Workflow";
  return undefined;
}

async function probeBuildRun(
  adapter: RuntimeProbeAdapter,
  environment: RuntimeEvidenceV1["environment"],
  observedAt: string,
): Promise<RuntimeEvidenceV1> {
  const query = await psqlJson<BuildRunRow>(
    adapter,
    `SELECT json_build_object('buildRunId', id, 'status', status, 'kind', kind, 'workflowId', temporal_workflow_id, 'workflowRunId', temporal_run_id, 'createdAt', created_at)::text FROM site_build_run ORDER BY created_at DESC LIMIT 1`,
  );
  const buildRunId = text(query.value?.buildRunId);
  const status = text(query.value?.status) ?? "UNKNOWN";
  const kind = text(query.value?.kind);
  const workflowNode = buildWorkflowNode(kind);
  try {
    return createRuntimeRecord({
      kind: "BUILD_RUN",
      environment,
      subject: buildRunId ?? "latest-build-run",
      observedAt,
      sourceObservedAt: text(query.value?.createdAt),
      graphNodeIds: [
        "data-model:prisma:SiteBuildRun",
        ...(workflowNode ? [workflowNode] : []),
      ],
      workflowId: text(query.value?.workflowId),
      workflowRunId: text(query.value?.workflowRunId),
      buildRunId,
      outcome:
        status === "succeeded"
          ? "SUCCESS"
          : ["failed", "cancelled"].includes(status)
            ? "FAILURE"
            : "UNKNOWN",
      durationMs: query.durationMs,
      metadata: {
        executionStatus: status,
        buildKind: kind ?? null,
        workflowIdentityPersisted: Boolean(text(query.value?.workflowId)),
        runtimeRevisionProven: false,
      },
    });
  } catch {
    return createRuntimeRecord({
      kind: "BUILD_RUN",
      environment,
      subject: "latest-build-run",
      observedAt,
      graphNodeIds: ["data-model:prisma:SiteBuildRun"],
      outcome: "FAILURE",
      durationMs: query.durationMs,
      metadata: {
        executionStatus: "UNKNOWN",
        buildKind: null,
        workflowIdentityPersisted: false,
        runtimeRevisionProven: false,
      },
    });
  }
}

async function atomicWrite(file: string, body: string): Promise<void> {
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
}

function assertCollectorEvidence(
  collector: RuntimeEvidenceBundleV1["collector"],
): void {
  const keys = new Set([
    "schemaVersion",
    "repositoryRoot",
    "worktreePath",
    "branch",
    "commit",
    "commitTime",
    "dirty",
    "sourceHash",
  ]);
  if (
    !collector ||
    typeof collector !== "object" ||
    !hasExactKeys(collector as unknown as Record<string, unknown>, keys) ||
    collector.schemaVersion !== "evidence-ref/v1" ||
    !GIT_COMMIT.test(collector.commit) ||
    !SHA_256.test(collector.sourceHash) ||
    !isIsoTimestamp(collector.commitTime) ||
    typeof collector.dirty !== "boolean"
  ) {
    throw new Error("runtime evidence collector schema is invalid");
  }
  assertSafePath(collector.repositoryRoot, "collector.repositoryRoot");
  assertSafePath(collector.worktreePath, "collector.worktreePath");
  assertSafeString(collector.branch, "collector.branch", SAFE_BRANCH);
}

function assertRuntimeEvidenceBundle(bundle: RuntimeEvidenceBundleV1): void {
  const keys = new Set([
    "schemaVersion",
    "environment",
    "capturedAt",
    "collector",
    "records",
  ]);
  if (
    !bundle ||
    typeof bundle !== "object" ||
    !hasExactKeys(bundle as unknown as Record<string, unknown>, keys) ||
    bundle.schemaVersion !== "runtime-evidence-bundle/v1" ||
    !["development", "preproduction"].includes(bundle.environment) ||
    !isIsoTimestamp(bundle.capturedAt) ||
    !Array.isArray(bundle.records) ||
    bundle.records.length === 0
  ) {
    throw new Error("runtime evidence bundle schema is invalid");
  }
  assertCollectorEvidence(bundle.collector);
  if (bundle.collector.dirty) {
    throw new Error(
      "runtime evidence bundle cannot originate from a dirty worktree",
    );
  }
  if (
    bundle.records.some(
      (record) =>
        record.environment !== bundle.environment ||
        record.observedAt !== bundle.capturedAt ||
        !verifyRuntimeRecord(record),
    )
  ) {
    throw new Error("runtime evidence record integrity check failed");
  }
}

export async function writeRuntimeEvidenceBundle(
  repositoryRoot: string,
  bundle: RuntimeEvidenceBundleV1,
): Promise<{ bundlePath: string; manifestPath: string }> {
  assertRuntimeEvidenceBundle(bundle);
  const outputDirectory = path.join(
    path.resolve(repositoryRoot),
    OUTPUT_DIRECTORY,
  );
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const bundlePath = path.join(outputDirectory, BUNDLE_FILE);
  const manifestPath = path.join(outputDirectory, MANIFEST_FILE);
  const body = stableJson(bundle);
  await atomicWrite(bundlePath, body);
  await atomicWrite(
    manifestPath,
    stableJson({
      schemaVersion: "runtime-evidence-artifact-manifest/v1",
      collector: bundle.collector,
      files: { [BUNDLE_FILE]: sha256(body) },
    }),
  );
  return { bundlePath, manifestPath };
}

export async function readRuntimeEvidenceBundle(
  repositoryRoot: string,
): Promise<RuntimeEvidenceBundleV1> {
  const outputDirectory = path.join(
    path.resolve(repositoryRoot),
    OUTPUT_DIRECTORY,
  );
  const [body, manifestBody] = await Promise.all([
    readFile(path.join(outputDirectory, BUNDLE_FILE), "utf8"),
    readFile(path.join(outputDirectory, MANIFEST_FILE), "utf8"),
  ]);
  const manifest = JSON.parse(manifestBody) as {
    schemaVersion?: string;
    collector?: RuntimeEvidenceBundleV1["collector"];
    files?: Record<string, string>;
  };
  if (
    !manifest ||
    typeof manifest !== "object" ||
    !hasExactKeys(
      manifest as unknown as Record<string, unknown>,
      new Set(["schemaVersion", "collector", "files"]),
    ) ||
    manifest.schemaVersion !== "runtime-evidence-artifact-manifest/v1" ||
    !manifest.collector ||
    !manifest.files ||
    !hasExactKeys(manifest.files, new Set([BUNDLE_FILE])) ||
    !SHA_256.test(manifest.files[BUNDLE_FILE] ?? "") ||
    manifest.files?.[BUNDLE_FILE] !== sha256(body)
  ) {
    throw new Error("runtime evidence artifact integrity check failed");
  }
  const bundle = JSON.parse(body) as RuntimeEvidenceBundleV1;
  assertRuntimeEvidenceBundle(bundle);
  assertCollectorEvidence(manifest.collector);
  if (stableJson(manifest.collector) !== stableJson(bundle.collector)) {
    throw new Error(
      "runtime evidence manifest collector does not match bundle",
    );
  }
  return bundle;
}

export interface RuntimeEvidenceFreshnessOptions {
  now?: Date;
  maxAgeMs?: number;
}

export function assertDevelopmentRuntimeEnvironment(
  environment: string,
): asserts environment is "development" {
  if (environment !== "development") {
    throw new Error(
      "runtime-capture currently supports development only; production/preproduction require separate approval",
    );
  }
}

export async function runtimeEvidenceFreshnessDiagnostics(
  repositoryRoot: string,
  bundle: RuntimeEvidenceBundleV1,
  options: RuntimeEvidenceFreshnessOptions = {},
): Promise<RuntimeEvidenceDiagnosticV1[]> {
  const current = await createEvidence(repositoryRoot);
  const diagnostics: RuntimeEvidenceDiagnosticV1[] = [];
  if (
    path.resolve(bundle.collector.repositoryRoot) !==
      path.resolve(current.repositoryRoot) ||
    path.resolve(bundle.collector.worktreePath) !==
      path.resolve(current.worktreePath)
  ) {
    diagnostics.push({
      code: "RUNTIME_EVIDENCE_WRONG_WORKTREE",
      severity: "error",
      message: `runtime evidence belongs to ${bundle.collector.worktreePath}, current worktree is ${current.worktreePath}`,
    });
  }
  if (
    bundle.collector.branch !== current.branch ||
    bundle.collector.commit !== current.commit ||
    bundle.collector.commitTime !== current.commitTime ||
    bundle.collector.sourceHash !== current.sourceHash ||
    bundle.collector.dirty ||
    current.dirty
  ) {
    diagnostics.push({
      code: "RUNTIME_EVIDENCE_STALE",
      severity: "error",
      message:
        "runtime evidence collector branch, commit, commit time, source hash, or clean state does not match the current worktree",
    });
  }
  const now = options.now ?? new Date();
  const maxAgeMs = options.maxAgeMs ?? MAX_RUNTIME_EVIDENCE_AGE_MS;
  const capturedAt = Date.parse(bundle.capturedAt);
  const ageMs = now.getTime() - capturedAt;
  if (
    !Number.isFinite(capturedAt) ||
    !Number.isFinite(maxAgeMs) ||
    maxAgeMs <= 0 ||
    ageMs > maxAgeMs ||
    ageMs < -MAX_CLOCK_SKEW_MS
  ) {
    diagnostics.push({
      code: "RUNTIME_EVIDENCE_STALE",
      severity: "error",
      message: `runtime evidence is outside the allowed freshness window of ${maxAgeMs}ms`,
    });
  }
  return diagnostics;
}

export async function collectDevelopmentRuntimeEvidence(
  repositoryRoot: string,
  adapter: RuntimeProbeAdapter = defaultAdapter(),
): Promise<RuntimeEvidenceBundleV1> {
  const resolved = path.resolve(repositoryRoot);
  const graph = await readGraph(resolved);
  const graphDiagnostics = await graphFreshnessDiagnostics(resolved, graph);
  if (graphDiagnostics.length > 0) {
    throw new Error(
      "refusing runtime capture because ContractGraph is stale or belongs to another worktree",
    );
  }
  const collector = await createEvidence(resolved);
  if (collector.dirty) {
    throw new Error(
      "refusing runtime capture from a dirty worktree; commit and rebuild ContractGraph first",
    );
  }
  const environment = "development" as const;
  const capturedAt = adapter.now().toISOString();
  const [api, databaseApi, systemd, compose, temporal, schedules] =
    await Promise.all([
      probeApi(
        adapter,
        environment,
        capturedAt,
        "http://127.0.0.1:3000/api/v1/health",
        "global-api",
        "api:GET:/health",
        "status",
      ),
      probeApi(
        adapter,
        environment,
        capturedAt,
        "http://127.0.0.1:3000/api/v1/health/db",
        "global-api-db",
        "api:GET:/health/db",
        "db",
      ),
      probeSystemd(adapter, environment, capturedAt),
      probeCompose(adapter, environment, capturedAt),
      probeTemporalCluster(adapter, environment, capturedAt),
      probeTemporalSchedules(adapter, graph, environment, capturedAt),
    ]);
  const [migration, outbox, buildRun] = await Promise.all([
    probeMigration(adapter, environment, capturedAt),
    probeOutbox(adapter, environment, capturedAt),
    probeBuildRun(adapter, environment, capturedAt),
  ]);
  const records = [
    api,
    databaseApi,
    ...systemd,
    ...compose,
    temporal,
    ...schedules,
    migration,
    outbox,
    buildRun,
  ].sort((left, right) => left.id.localeCompare(right.id));
  const collectorAfterProbes = await createEvidence(resolved);
  if (
    collectorAfterProbes.dirty ||
    stableJson(collectorAfterProbes) !== stableJson(collector)
  ) {
    throw new Error(
      "refusing runtime capture because worktree provenance changed while probes were running",
    );
  }
  const bundle: RuntimeEvidenceBundleV1 = {
    schemaVersion: "runtime-evidence-bundle/v1",
    environment,
    capturedAt,
    collector,
    records,
  };
  await writeRuntimeEvidenceBundle(resolved, bundle);
  return bundle;
}

function requiredStaticTargets(graph: ContractGraphV1): {
  nodeIds: string[];
  edgeIds: string[];
} {
  return {
    nodeIds: graph.nodes
      .filter((node) => node.attributes.requiresRuntimeEvidence === true)
      .map((node) => node.id),
    edgeIds: graph.edges
      .filter((edge) => edge.attributes.requiresRuntimeEvidence === true)
      .map((edge) => edge.id),
  };
}

function temporalScheduleBindingMatchesGraph(
  graph: ContractGraphV1,
  record: RuntimeEvidenceV1,
): boolean {
  if (
    record.kind !== "TEMPORAL_SCHEDULE" ||
    record.subject === "schedule-list"
  ) {
    return true;
  }
  const workflowType = record.metadata.workflowType;
  if (typeof workflowType !== "string") return false;
  const expected = graphEdgeIds(
    graph,
    `service:temporal-schedule:${record.subject}`,
    `workflow:temporal:${workflowType}`,
    "calls",
  );
  return (
    new Set(expected).size === expected.length &&
    stableJson(uniqueSorted(record.graphEdgeIds)) ===
      stableJson(uniqueSorted(expected))
  );
}

export function createRuntimeDifferenceReport(
  graph: ContractGraphV1,
  bundle: RuntimeEvidenceBundleV1,
): RuntimeDifferenceReportV1 {
  assertRuntimeEvidenceBundle(bundle);
  const graphNodeIds = new Set(graph.nodes.map((node) => node.id));
  const graphEdgeIds = new Set(graph.edges.map((edge) => edge.id));
  const successful = bundle.records.filter(
    (record) => record.outcome === "SUCCESS",
  );
  const invalidScheduleBindings = bundle.records.filter(
    (record) =>
      record.kind === "TEMPORAL_SCHEDULE" &&
      record.subject !== "schedule-list" &&
      !temporalScheduleBindingMatchesGraph(graph, record),
  );
  const invalidScheduleBindingIds = new Set(
    invalidScheduleBindings.map((record) => record.id),
  );
  const observedNodeIds = uniqueSorted(
    successful.flatMap((record) =>
      record.graphNodeIds.filter((id) => graphNodeIds.has(id)),
    ),
  );
  const observedEdgeIds = uniqueSorted(
    successful.flatMap((record) =>
      invalidScheduleBindingIds.has(record.id)
        ? []
        : record.graphEdgeIds.filter((id) => graphEdgeIds.has(id)),
    ),
  );
  const runtimeOnlyNodeIds = uniqueSorted(
    bundle.records.flatMap((record) =>
      record.graphNodeIds.filter((id) => !graphNodeIds.has(id)),
    ),
  );
  const runtimeOnlyEdgeIds = uniqueSorted(
    bundle.records.flatMap((record) =>
      record.graphEdgeIds.filter((id) => !graphEdgeIds.has(id)),
    ),
  );
  const required = requiredStaticTargets(graph);
  const observedNodeSet = new Set(observedNodeIds);
  const observedEdgeSet = new Set(observedEdgeIds);
  const staticOnlyNodeIds = required.nodeIds.filter(
    (id) => !observedNodeSet.has(id),
  );
  const staticOnlyEdgeIds = required.edgeIds.filter(
    (id) => !observedEdgeSet.has(id),
  );
  const failedEvidenceIds = bundle.records
    .filter((record) => record.outcome === "FAILURE")
    .map((record) => record.id)
    .sort();
  const diagnostics: RuntimeEvidenceDiagnosticV1[] = [];
  const unprovenRuntimeCommits = bundle.records.filter(
    (record) => record.commit === UNKNOWN_COMMIT,
  );
  if (unprovenRuntimeCommits.length > 0) {
    diagnostics.push({
      code: "RUNTIME_COMMIT_UNPROVEN",
      severity: "warning",
      message: `${unprovenRuntimeCommits.length} runtime records prove metadata/health but the running artifact does not expose its source commit`,
    });
  }
  const configurationDrift = bundle.records
    .filter((record) => record.kind === "COMPOSE_SERVICE")
    .filter((record) => {
      const configurationRoot = record.metadata.configurationRoot;
      return (
        typeof configurationRoot === "string" &&
        path.resolve(configurationRoot) !==
          path.resolve(graph.evidence.repositoryRoot)
      );
    })
    .map((record) => record.subject)
    .sort();
  if (configurationDrift.length > 0) {
    diagnostics.push({
      code: "RUNTIME_CONFIGURATION_PROVENANCE_DRIFT",
      severity: "warning",
      message: `${configurationDrift.length} Compose services were created from non-canonical worktree configuration: ${configurationDrift.join(", ")}`,
    });
  }
  if (runtimeOnlyNodeIds.length > 0 || runtimeOnlyEdgeIds.length > 0) {
    diagnostics.push({
      code: "RUNTIME_GRAPH_TARGET_MISSING",
      severity: "error",
      message: `${runtimeOnlyNodeIds.length} runtime nodes and ${runtimeOnlyEdgeIds.length} runtime edges do not exist in the current ContractGraph`,
    });
  }
  if (invalidScheduleBindings.length > 0) {
    diagnostics.push({
      code: "RUNTIME_GRAPH_TARGET_MISSING",
      severity: "error",
      message: `${invalidScheduleBindings.length} Temporal Schedule records do not bind to the exact current Schedule-to-Workflow calls edge`,
    });
  }
  const failedHealth = bundle.records.filter(
    (record) =>
      record.outcome === "FAILURE" && HEALTH_FAILURE_KINDS.has(record.kind),
  );
  if (failedHealth.length > 0) {
    diagnostics.push({
      code: "RUNTIME_PROBE_FAILED",
      severity: "error",
      message: `${failedHealth.length} health, service, cluster, or migration probes failed`,
    });
  }
  if (staticOnlyNodeIds.length > 0 || staticOnlyEdgeIds.length > 0) {
    diagnostics.push({
      code: "STATIC_RELATION_UNOBSERVED",
      severity: "warning",
      message: `${staticOnlyNodeIds.length} required static nodes and ${staticOnlyEdgeIds.length} required static edges remain unobserved; absence of evidence is not proof of disconnection`,
    });
  }
  const unknownEvidence = bundle.records.filter(
    (record) => record.outcome === "UNKNOWN",
  );
  if (unknownEvidence.length > 0) {
    diagnostics.push({
      code: "RUNTIME_HEALTH_UNPROVEN",
      severity: "warning",
      message: `${unknownEvidence.length} runtime records remain UNKNOWN; a running service without a declared healthcheck is not treated as healthy`,
    });
  }
  const missingCorrelation = bundle.records.filter(
    (record) =>
      record.kind === "API_HEALTH" && record.metadata.requestIdEchoed === false,
  );
  if (missingCorrelation.length > 0) {
    diagnostics.push({
      code: "API_CORRELATION_UNPROVEN",
      severity: "warning",
      message: `${missingCorrelation.length} API health probes did not echo the supplied X-Request-Id, so no correlation ID was claimed`,
    });
  }
  const contradicted = diagnostics.some(
    (diagnostic) => diagnostic.severity === "error",
  );
  return {
    schemaVersion: "runtime-difference-report/v1",
    evidence: graph.evidence,
    environment: bundle.environment,
    capturedAt: bundle.capturedAt,
    conclusion: contradicted
      ? "CONTRADICTED"
      : diagnostics.length > 0
        ? "PARTIAL"
        : "CONSISTENT",
    observedNodeIds,
    observedEdgeIds,
    staticOnlyNodeIds,
    staticOnlyEdgeIds,
    runtimeOnlyNodeIds,
    runtimeOnlyEdgeIds,
    failedEvidenceIds,
    diagnostics,
  };
}

export async function buildRuntimeDifferenceReport(
  repositoryRoot: string,
): Promise<RuntimeDifferenceReportV1> {
  const resolved = path.resolve(repositoryRoot);
  const [graph, bundle] = await Promise.all([
    readGraph(resolved),
    readRuntimeEvidenceBundle(resolved),
  ]);
  const [graphDiagnostics, runtimeDiagnostics] = await Promise.all([
    graphFreshnessDiagnostics(resolved, graph),
    runtimeEvidenceFreshnessDiagnostics(resolved, bundle),
  ]);
  if (graphDiagnostics.length > 0 || runtimeDiagnostics.length > 0) {
    throw new Error(
      "refusing runtime difference report because graph or runtime evidence is stale/wrong-worktree",
    );
  }
  const report = createRuntimeDifferenceReport(graph, bundle);
  await atomicWrite(
    path.join(resolved, OUTPUT_DIRECTORY, DIFFERENCE_FILE),
    stableJson(report),
  );
  return report;
}
