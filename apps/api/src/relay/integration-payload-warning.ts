import type { LoggerService } from "@nestjs/common";
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
