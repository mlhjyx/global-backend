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

const SYSTEMD_UNITS = [
  "global-api.service",
  "global-worker.service",
  "temporal-dev.service",
] as const;

const HEALTH_FAILURE_KINDS = new Set<RuntimeEvidenceV1["kind"]>([
  "API_HEALTH",
  "SYSTEMD_SERVICE",
  "COMPOSE_SERVICE",
  "TEMPORAL_CLUSTER",
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
  correlationId?: unknown;
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

function assertSafeMetadata(metadata: RuntimeEvidenceV1["metadata"]): void {
  const forbidden =
    /(?:payload|body|prompt|secret|token|password|credential|email|personal)/i;
  for (const [key, value] of Object.entries(metadata)) {
    if (forbidden.test(key)) {
      throw new Error(`runtime evidence metadata key is forbidden: ${key}`);
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
  }
}

export function createRuntimeRecord(
  input: RuntimeRecordInput,
): RuntimeEvidenceV1 {
  if (
    !input.subject ||
    input.subject.length > 1024 ||
    /[\u0000-\u001f]/.test(input.subject)
  ) {
    throw new Error("runtime evidence subject is missing, too long, or unsafe");
  }
  const metadata = input.metadata ?? {};
  assertSafeMetadata(metadata);
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
      !record.id.startsWith("runtime:") ||
      !record.subject ||
      record.subject.length > 1024 ||
      /[\u0000-\u001f]/.test(record.subject) ||
      !["development", "preproduction"].includes(record.environment) ||
      !Array.isArray(record.graphNodeIds) ||
      !Array.isArray(record.graphEdgeIds) ||
      !record.metadata ||
      typeof record.metadata !== "object" ||
      (record.commit !== UNKNOWN_COMMIT &&
        !/^[a-f0-9]{40}$/.test(record.commit))
    ) {
      return false;
    }
    assertSafeMetadata(record.metadata);
    const { evidenceHash, ...withoutHash } = record;
    return evidenceHash === sha256(stableJson(withoutHash));
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
    const expected = body[expectedKey] === "ok";
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
        requestIdEchoed: echoed === requestId,
        service: expectedKey === "status" ? (text(body.service) ?? null) : null,
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
          ["running", "exited"].includes(properties.SubState ?? "");
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
          state === "running" && !["unhealthy", "starting"].includes(health)
            ? "SUCCESS"
            : "FAILURE",
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
}

async function probeOutbox(
  adapter: RuntimeProbeAdapter,
  environment: RuntimeEvidenceV1["environment"],
  observedAt: string,
): Promise<RuntimeEvidenceV1> {
  const query = await psqlJson<OutboxRow>(
    adapter,
    `SELECT json_build_object('eventId', event_id, 'eventType', event_type, 'correlationId', correlation_id, 'occurredAt', occurred_at, 'deliveryState', CASE WHEN published_at IS NOT NULL THEN 'PUBLISHED' WHEN parked_at IS NOT NULL THEN 'PARKED' ELSE 'PENDING' END)::text FROM outbox_event ORDER BY occurred_at DESC LIMIT 1`,
  );
  const eventId = text(query.value?.eventId);
  const eventType = text(query.value?.eventType);
  const deliveryState = text(query.value?.deliveryState) ?? "UNKNOWN";
  const eventNode = eventType ? `event:outbox:${eventType}` : undefined;
  return createRuntimeRecord({
    kind: "OUTBOX_EVENT",
    environment,
    subject: eventType ?? "latest-outbox-event",
    observedAt,
    sourceObservedAt: text(query.value?.occurredAt),
    graphNodeIds: eventNode ? [eventNode] : [],
    // Existence proves the event type occurred, not that a static consumer ran.
    graphEdgeIds: [],
    correlationId: text(query.value?.correlationId),
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
      runtimeRevisionProven: false,
    },
  });
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
}

async function atomicWrite(file: string, body: string): Promise<void> {
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
}

export async function writeRuntimeEvidenceBundle(
  repositoryRoot: string,
  bundle: RuntimeEvidenceBundleV1,
): Promise<{ bundlePath: string; manifestPath: string }> {
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
    files?: Record<string, string>;
  };
  if (
    manifest.schemaVersion !== "runtime-evidence-artifact-manifest/v1" ||
    manifest.files?.[BUNDLE_FILE] !== sha256(body)
  ) {
    throw new Error("runtime evidence artifact integrity check failed");
  }
  const bundle = JSON.parse(body) as RuntimeEvidenceBundleV1;
  if (
    bundle.schemaVersion !== "runtime-evidence-bundle/v1" ||
    !Array.isArray(bundle.records) ||
    bundle.records.some(
      (record) =>
        record.schemaVersion !== "runtime-evidence/v1" ||
        !verifyRuntimeRecord(record),
    )
  ) {
    throw new Error("runtime evidence record integrity check failed");
  }
  return bundle;
}

export async function runtimeEvidenceFreshnessDiagnostics(
  repositoryRoot: string,
  bundle: RuntimeEvidenceBundleV1,
): Promise<RuntimeEvidenceDiagnosticV1[]> {
  const current = await createEvidence(repositoryRoot);
  const diagnostics: RuntimeEvidenceDiagnosticV1[] = [];
  if (
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
    bundle.collector.commit !== current.commit ||
    bundle.collector.sourceHash !== current.sourceHash
  ) {
    diagnostics.push({
      code: "RUNTIME_EVIDENCE_STALE",
      severity: "error",
      message:
        "runtime evidence collector commit or source hash does not match the current worktree",
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

export function createRuntimeDifferenceReport(
  graph: ContractGraphV1,
  bundle: RuntimeEvidenceBundleV1,
): RuntimeDifferenceReportV1 {
  const graphNodeIds = new Set(graph.nodes.map((node) => node.id));
  const graphEdgeIds = new Set(graph.edges.map((edge) => edge.id));
  const successful = bundle.records.filter(
    (record) => record.outcome === "SUCCESS",
  );
  const observedNodeIds = uniqueSorted(
    successful.flatMap((record) =>
      record.graphNodeIds.filter((id) => graphNodeIds.has(id)),
    ),
  );
  const observedEdgeIds = uniqueSorted(
    successful.flatMap((record) =>
      record.graphEdgeIds.filter((id) => graphEdgeIds.has(id)),
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
  if (runtimeOnlyNodeIds.length > 0 || runtimeOnlyEdgeIds.length > 0) {
    diagnostics.push({
      code: "RUNTIME_GRAPH_TARGET_MISSING",
      severity: "error",
      message: `${runtimeOnlyNodeIds.length} runtime nodes and ${runtimeOnlyEdgeIds.length} runtime edges do not exist in the current ContractGraph`,
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
  if (
    bundle.records.some(
      (record) =>
        record.outcome === "UNKNOWN" ||
        (record.kind === "API_HEALTH" &&
          record.metadata.requestIdEchoed === false),
    )
  ) {
    diagnostics.push({
      code: "STATIC_RELATION_UNOBSERVED",
      severity: "warning",
      message:
        "one or more probes remain UNKNOWN or the API did not echo a correlation ID",
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
