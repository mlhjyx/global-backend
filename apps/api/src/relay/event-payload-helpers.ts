import type { LoggerService } from "@nestjs/common";
import {
  matchesAssetCleanupPayload,
  parseAssetCleanupCommand,
} from "../temporal/asset-cleanup.contract";
import type { QualifyRunInput } from "../temporal/qualify.activities";
import { NonRetryableOutboxCommandError } from "./discovery-run-command";
import { type PayloadEvent, validateIntegrationEventWarnOnly } from "./event-registry";

/**
 * Compatibility rollout: historical payloads are accepted by the envelope gate;
 * the stricter v1 shape is observed as a warning only (never parks, never changes
 * the consumer). Promotion to fail-closed is a separate decision after replay.
 */
export function logIntegrationPayloadWarning(
  logger: LoggerService,
  ev: PayloadEvent,
): void {
  const warning = validateIntegrationEventWarnOnly(ev);
  if (warning && !warning.ok) {
    logger.warn(
      `integration event ${ev.eventId} (${ev.eventType}) payload warning: ${warning.reason}`,
    );
  }
}

/**
 * PR-06b: QualifyRequested → qualifyWorkflow args. 发现 run 收尾触发的评分带上
 * payload.runId：runRef 记进批次引用，discoveryRunId 让评分批次写 run_event 留痕。
 * 历史 payload 缺 runId 时保持旧的 {workspaceId, icpId} 形状。
 */
export function qualifyWorkflowArgs(
  ev: Pick<PayloadEvent, "workspaceId" | "aggregateId" | "payload">,
): QualifyRunInput {
  const payload =
    ev.payload !== null && typeof ev.payload === "object" && !Array.isArray(ev.payload)
      ? (ev.payload as { runId?: unknown })
      : {};
  const discoveryRunId =
    typeof payload.runId === "string" && payload.runId.length > 0 ? payload.runId : undefined;
  return {
    workspaceId: ev.workspaceId,
    icpId: ev.aggregateId,
    ...(discoveryRunId ? { runRef: discoveryRunId, discoveryRunId } : {}),
  };
}

export function assertPersonalArtifactCleanupOutboxPayload(ev: {
  aggregateId: string;
  schemaVersion: number;
  payload: unknown;
}): void {
  const payload =
    ev.payload !== null && typeof ev.payload === "object" && !Array.isArray(ev.payload)
      ? (ev.payload as Record<string, unknown>)
      : null;
  if (
    ev.schemaVersion !== 1 ||
    !payload ||
    Reflect.ownKeys(payload).length !== 1 ||
    payload.deletionRequestId !== ev.aggregateId
  ) {
    throw new NonRetryableOutboxCommandError(
      "personal artifact cleanup payload contract mismatch",
    );
  }
}

export function parseAssetCleanupOutboxCommand(ev: {
  eventId: string;
  workspaceId: string;
  aggregateId: string;
  schemaVersion: number;
  payload: unknown;
}): ReturnType<typeof parseAssetCleanupCommand> {
  const payload = (ev.payload ?? {}) as Record<string, unknown>;
  try {
    if (payload.assetId !== ev.aggregateId) {
      throw new Error("cleanup payload assetId must match Outbox aggregateId");
    }
    if (
      (payload.objectClass === "staging" && ev.schemaVersion !== 1) ||
      (payload.objectClass === "canonical" && ev.schemaVersion !== 2)
    ) {
      throw new Error("cleanup Outbox schemaVersion does not match objectClass");
    }
    const command = parseAssetCleanupCommand({
      eventId: ev.eventId,
      workspaceId: ev.workspaceId,
      assetId: ev.aggregateId,
      siteId: payload.siteId,
      objectClass: payload.objectClass,
      reason: payload.reason,
      ...(payload.objectClass === "staging"
        ? { objectKey: payload.objectKey, notBefore: payload.notBefore }
        : { canonical: payload.canonical, variants: payload.variants }),
    });
    if (!matchesAssetCleanupPayload(payload, command)) {
      throw new Error("cleanup Outbox payload contains unknown or mismatched fields");
    }
    return command;
  } catch (error) {
    throw new NonRetryableOutboxCommandError(
      error instanceof Error ? error.message : String(error),
    );
  }
}
