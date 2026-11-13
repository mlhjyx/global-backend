import type { LoggerService } from "@nestjs/common";
import type { QualifyRunInput } from "../temporal/qualify.activities";
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
