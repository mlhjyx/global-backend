import { types } from "node:util";

import type { RuntimeComponentStatus } from "../runtime/runtime-readiness-registry";
import {
  PLATFORM_AUTOMATION_READINESS_STATES,
  type PlatformAutomationDesiredMode,
  type PlatformAutomationReadinessIdentity,
  type PlatformAutomationReadinessRow,
  type PlatformAutomationReadinessState,
} from "./platform-automation-readiness";
import {
  PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1,
  type PlatformExecutionScheduleId,
  type PlatformExecutionTechnicalRowV1,
} from "./platform-execution-contract";

export interface PlatformAutomationHealthProjection {
  readonly schemaVersion: "platform-automation-readiness/v1";
  readonly rows: readonly PlatformAutomationReadinessRow[];
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function identity(
  row: PlatformExecutionTechnicalRowV1,
): PlatformAutomationReadinessIdentity {
  return deepFreeze({
    temporalNamespace: row.temporalNamespace,
    scheduleId: row.scheduleId,
    purpose: row.purpose,
    workflowType: row.workflowType,
    taskQueue: row.taskQueue,
  });
}

function desiredMode(
  row: PlatformExecutionTechnicalRowV1,
): PlatformAutomationDesiredMode {
  return row.costMode === "disabled_no_egress"
    ? "INTENTIONALLY_DISABLED_NO_EGRESS"
    : "ENABLED";
}

function code(
  scheduleId: PlatformExecutionScheduleId,
  state: PlatformAutomationReadinessState,
): string {
  return `PLATFORM_AUTOMATION_${scheduleId.replaceAll("-", "_").toUpperCase()}_${state}`;
}

function rowProjection(
  row: PlatformExecutionTechnicalRowV1,
  state: PlatformAutomationReadinessState,
): PlatformAutomationReadinessRow {
  return deepFreeze({
    identity: identity(row),
    desiredMode: desiredMode(row),
    state,
    code: code(row.scheduleId, state),
  });
}

function ownDataSnapshot(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      types.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return null;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
      Object.keys(descriptors).sort().join("\0") !==
        [...expectedKeys].sort().join("\0")
    ) {
      return null;
    }
    const snapshot: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (
        !descriptor?.enumerable ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      ) {
        return null;
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function exactRows(value: unknown): readonly unknown[] | null {
  try {
    if (
      !Array.isArray(value) ||
      types.isProxy(value) ||
      Object.getPrototypeOf(value) !== Array.prototype ||
      value.length !== PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1.rows.length
    ) {
      return null;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Reflect.ownKeys(descriptors).some(
        (key) =>
          typeof key !== "string" ||
          (key !== "length" && !/^(?:0|[1-9][0-9]*)$/.test(key)),
      ) ||
      Reflect.ownKeys(descriptors).length !== value.length + 1
    ) {
      return null;
    }
    const rows: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
        return null;
      }
      rows.push(descriptor.value);
    }
    return Object.freeze(rows);
  } catch {
    return null;
  }
}

function unavailableHealthProjection(): PlatformAutomationHealthProjection {
  return deepFreeze({
    schemaVersion: "platform-automation-readiness/v1" as const,
    rows: PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1.rows.map((row) =>
      rowProjection(row, "BLOCKED"),
    ),
  });
}

/** Strictly projects only the four code-owned identities and closed states. */
export function tryProjectPlatformAutomationReadinessForHealth(
  input: unknown,
): PlatformAutomationHealthProjection | null {
  const report = ownDataSnapshot(input, ["status", "rows"]);
  const inputs = exactRows(report?.rows);
  if (
    !report ||
    !inputs ||
    (report.status !== "ready" && report.status !== "not_ready")
  ) {
    return null;
  }
  const projected: PlatformAutomationReadinessRow[] = [];
  for (let index = 0; index < inputs.length; index += 1) {
    const source = ownDataSnapshot(inputs[index], [
      "identity",
      "desiredMode",
      "state",
      "code",
    ]);
    const sourceIdentity = ownDataSnapshot(source?.identity, [
      "temporalNamespace",
      "scheduleId",
      "purpose",
      "workflowType",
      "taskQueue",
    ]);
    const expected = PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1.rows[index];
    if (
      !source ||
      !sourceIdentity ||
      !expected ||
      sourceIdentity.temporalNamespace !== expected.temporalNamespace ||
      sourceIdentity.scheduleId !== expected.scheduleId ||
      sourceIdentity.purpose !== expected.purpose ||
      sourceIdentity.workflowType !== expected.workflowType ||
      sourceIdentity.taskQueue !== expected.taskQueue ||
      source.desiredMode !== desiredMode(expected) ||
      !PLATFORM_AUTOMATION_READINESS_STATES.includes(
        source.state as PlatformAutomationReadinessState,
      ) ||
      source.code !==
        code(
          expected.scheduleId,
          source.state as PlatformAutomationReadinessState,
        )
    ) {
      return null;
    }
    projected.push(
      rowProjection(expected, source.state as PlatformAutomationReadinessState),
    );
  }
  const healthy = projected.every((row) =>
    row.desiredMode === "ENABLED"
      ? row.state === "ISSUABLE"
      : row.state === "INTENTIONALLY_DISABLED_NO_EGRESS",
  );
  if (report.status !== (healthy ? "ready" : "not_ready")) return null;
  return deepFreeze({
    schemaVersion: "platform-automation-readiness/v1" as const,
    rows: projected,
  });
}

export function projectPlatformAutomationReadinessForHealth(
  input: unknown,
): PlatformAutomationHealthProjection {
  return (
    tryProjectPlatformAutomationReadinessForHealth(input) ??
    unavailableHealthProjection()
  );
}

export function platformAutomationAggregateFromHealthProjection(
  projection: PlatformAutomationHealthProjection,
): RuntimeComponentStatus {
  const closed = projection.rows.find((row) =>
    row.desiredMode === "ENABLED"
      ? row.state !== "ISSUABLE"
      : row.state !== "INTENTIONALLY_DISABLED_NO_EGRESS",
  );
  return closed
    ? Object.freeze({ status: "failed", code: closed.code })
    : Object.freeze({ status: "ok" });
}
