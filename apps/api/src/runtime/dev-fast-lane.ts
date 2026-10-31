import type { Duration } from "@temporalio/common";
import type { RuntimeAdmissionResult } from "./runtime-admission";
import type { RuntimeMode } from "./runtime-environment";
import type { RuntimeProcessLeaseService } from "./runtime-process-lease";
import type { RuntimeReleaseIdentity } from "./runtime-release-identity";

/**
 * Development fast lane (registered ADR-024 exception; operator guide in
 * docs/backend/dev-fast-lane.md).
 *
 * In development only, the attested API may route the three acquisition
 * commands of exactly one workspace to a tenant-scoped task queue on a
 * loopback development Temporal, where one source-built customer worker that
 * passes every managed admission check except the build receipt serves it.
 * Every other workspace, command and process keeps the managed path. Any lane
 * variable in test, pilot or production stops the process at start.
 *
 * Everything here is pure: callers pass the environment explicitly.
 */

export const DEV_FAST_LANE_WORKSPACE_ID_ENV =
  "RUNTIME_DEV_FAST_LANE_WORKSPACE_ID";
export const DEV_FAST_LANE_TEMPORAL_ADDRESS_ENV =
  "RUNTIME_DEV_FAST_LANE_TEMPORAL_ADDRESS";
export const DEV_FAST_LANE_SCHEMA_DIGEST_ENV =
  "RUNTIME_DEV_FAST_LANE_SCHEMA_DIGEST";

const DEV_FAST_LANE_ENV_KEYS = Object.freeze([
  DEV_FAST_LANE_WORKSPACE_ID_ENV,
  DEV_FAST_LANE_TEMPORAL_ADDRESS_ENV,
  DEV_FAST_LANE_SCHEMA_DIGEST_ENV,
]);

/** Nest token for the resolved lane (RuntimeModule provides it globally). */
export const DEV_FAST_LANE = Symbol("DEV_FAST_LANE");

export const DEV_FAST_LANE_TASK_QUEUE_PREFIX = "understanding-dev-fast-lane-";

/** The only commands that ever leave the managed task queue. */
export const DEV_FAST_LANE_ACQUISITION_COMMANDS = Object.freeze([
  "CompanyProfileCreated",
  "DiscoveryRunRequested",
  "QualifyRequested",
] as const);

export type DevFastLaneAcquisitionCommand =
  (typeof DEV_FAST_LANE_ACQUISITION_COMMANDS)[number];

/**
 * A lane workflow nobody polls must end instead of absorbing later requests
 * that reuse its workflow id. Discovery gets its 3-hour admission lease, the
 * longest wait before a retry after an unavailable model upstream (5 + 25
 * minutes, see temporal/upstream-unavailable-retry.ts) and 5 minutes of
 * finalization headroom, so a run that hits an outage late still finalizes
 * instead of timing out RUNNING; understanding and qualify get 30 minutes.
 */
const DEV_FAST_LANE_WORKFLOW_EXECUTION_TIMEOUTS: Readonly<
  Record<DevFastLaneAcquisitionCommand, Duration>
> = Object.freeze({
  CompanyProfileCreated: "30 minutes",
  DiscoveryRunRequested: "215 minutes",
  QualifyRequested: "30 minutes",
});

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOOPBACK_ADDRESS =
  /^(?:127\.0\.0\.1|localhost|\[::1\]):([1-9][0-9]{0,4})$/;
const MAX_PORT = 65_535;
const SCHEMA_DIGEST = /^sha256:[0-9a-f]{64}$/;

export type DevFastLane =
  | Readonly<{ enabled: false }>
  | Readonly<{
      enabled: true;
      workspaceId: string;
      taskQueue: string;
      temporalAddress: string;
      temporalNamespace: "default";
      /** schema_digest the managed image reports at /health/build. */
      expectedSchemaDigest: string | null;
    }>;

export type EnabledDevFastLane = Extract<DevFastLane, { enabled: true }>;

export type DevFastLaneRoute = Readonly<{
  taskQueue: string;
  workflowExecutionTimeout: Duration;
}>;

const DISABLED: DevFastLane = Object.freeze({ enabled: false });

function configuredKeys(env: NodeJS.ProcessEnv): string[] {
  return DEV_FAST_LANE_ENV_KEYS.filter((key) => (env[key] ?? "").trim() !== "");
}

function loopbackTemporalAddress(value: string): boolean {
  const match = LOOPBACK_ADDRESS.exec(value);
  return match !== null && Number(match[1]) <= MAX_PORT;
}

/** The single reader of the lane variables; it throws instead of ignoring a bad value. */
export function resolveDevFastLane(
  mode: RuntimeMode,
  env: NodeJS.ProcessEnv,
): DevFastLane {
  const configured = configuredKeys(env);
  if (mode !== "development") {
    if (configured.length > 0) {
      throw new Error(
        `DEV_FAST_LANE_FORBIDDEN_OUTSIDE_DEVELOPMENT: ${configured.join(", ")} is set but runtime mode is ${mode}`,
      );
    }
    return DISABLED;
  }
  const workspaceId = env[DEV_FAST_LANE_WORKSPACE_ID_ENV] ?? "";
  if (workspaceId.trim() === "") {
    if (configured.length > 0) {
      throw new Error(
        `DEV_FAST_LANE_CONFIGURATION_INVALID: ${configured.join(", ")} is set without ${DEV_FAST_LANE_WORKSPACE_ID_ENV}`,
      );
    }
    return DISABLED;
  }
  if (!CANONICAL_UUID.test(workspaceId)) {
    throw new Error(
      `DEV_FAST_LANE_WORKSPACE_ID_INVALID: ${DEV_FAST_LANE_WORKSPACE_ID_ENV} must be exactly one lowercase canonical UUID`,
    );
  }
  const temporalAddress = env[DEV_FAST_LANE_TEMPORAL_ADDRESS_ENV] ?? "";
  if (!loopbackTemporalAddress(temporalAddress)) {
    throw new Error(
      `DEV_FAST_LANE_TEMPORAL_ADDRESS_INVALID: ${DEV_FAST_LANE_TEMPORAL_ADDRESS_ENV} must be a loopback host:port (127.0.0.1, localhost or [::1])`,
    );
  }
  const schemaDigest = env[DEV_FAST_LANE_SCHEMA_DIGEST_ENV] ?? "";
  if (schemaDigest.trim() !== "" && !SCHEMA_DIGEST.test(schemaDigest)) {
    throw new Error(
      `DEV_FAST_LANE_SCHEMA_DIGEST_INVALID: ${DEV_FAST_LANE_SCHEMA_DIGEST_ENV} must be sha256: followed by 64 lowercase hex characters`,
    );
  }
  return Object.freeze({
    enabled: true,
    workspaceId,
    taskQueue: `${DEV_FAST_LANE_TASK_QUEUE_PREFIX}${workspaceId}`,
    temporalAddress,
    temporalNamespace: "default",
    expectedSchemaDigest: schemaDigest === "" ? null : schemaDigest,
  });
}

function isAcquisitionCommand(
  eventType: string,
): eventType is DevFastLaneAcquisitionCommand {
  return (DEV_FAST_LANE_ACQUISITION_COMMANDS as readonly string[]).includes(
    eventType,
  );
}

/** null keeps the command on the managed Temporal and task queue. */
export function devFastLaneRoute(
  lane: DevFastLane | undefined,
  eventType: string,
  workspaceId: string,
): DevFastLaneRoute | null {
  if (!lane?.enabled || workspaceId !== lane.workspaceId) return null;
  if (!isAcquisitionCommand(eventType)) return null;
  return Object.freeze({
    taskQueue: lane.taskQueue,
    workflowExecutionTimeout:
      DEV_FAST_LANE_WORKFLOW_EXECUTION_TIMEOUTS[eventType],
  });
}

/**
 * The customer worker becomes the lane worker only when the switch is on, the
 * build is unattested because its receipt is missing, and that missing
 * receipt is the only failed admission check.
 */
export function devFastLaneWorkerLane(
  lane: DevFastLane,
  identity: RuntimeReleaseIdentity,
  admission: Pick<RuntimeAdmissionResult, "checks">,
): Readonly<{ active: boolean; blocking: readonly string[] }> {
  const failed = Object.entries(admission.checks).filter(
    ([, check]) => check.status === "failed",
  );
  const blocking = failed.map(
    ([name, check]) => `${name}:${check.code ?? "FAILED"}`,
  );
  const active =
    lane.enabled &&
    !identity.attested &&
    identity.code === "DEV_FAST_LANE_UNATTESTED" &&
    failed.length === 1 &&
    failed[0]?.[0] === "build" &&
    failed[0]?.[1].code === "DEV_FAST_LANE_UNATTESTED";
  return Object.freeze({
    active,
    blocking: Object.freeze(active ? [] : blocking),
  });
}

/** Source schema must equal the schema the managed image was built from. */
export function checkDevFastLaneSourceSchema(
  lane: EnabledDevFastLane,
  sourceSchemaDigest: string,
):
  | Readonly<{ status: "ok" }>
  | Readonly<{
      status: "failed";
      code: "DEV_FAST_LANE_SCHEMA_DIGEST_REQUIRED" | "SCHEMA_DIGEST_MISMATCH";
    }> {
  if (lane.expectedSchemaDigest === null) {
    return { status: "failed", code: "DEV_FAST_LANE_SCHEMA_DIGEST_REQUIRED" };
  }
  if (lane.expectedSchemaDigest !== sourceSchemaDigest) {
    return { status: "failed", code: "SCHEMA_DIGEST_MISMATCH" };
  }
  return { status: "ok" };
}

/**
 * The lane worker never writes runtime_process_lease rows: the managed worker
 * and readiness keep seeing only the managed worker on 'understanding'.
 */
export const NULL_LEASE_WRITER: Pick<RuntimeProcessLeaseService, "heartbeat"> =
  Object.freeze({
    heartbeat: async () => undefined,
  });
