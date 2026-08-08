import { createHash } from 'node:crypto';

/**
 * Closed relay diagnostic taxonomy. Values are safe to persist and log; raw
 * exception messages, webhook URLs, response bodies, and credentials are not.
 */
export const RELAY_DIAGNOSTIC_CODE = Object.freeze({
  providerSeedFailed: 'PROVIDER_SEED_FAILED',
  sanctionsSeedFailed: 'SANCTIONS_SEED_FAILED',
  relayTickFailed: 'RELAY_TICK_FAILED',
  invalidInternalCommand: 'INVALID_INTERNAL_COMMAND',
  internalDispatchFailed: 'INTERNAL_DISPATCH_FAILED',
  deliveryRoutingFailed: 'DELIVERY_ROUTING_FAILED',
  eventParkFailed: 'EVENT_PARK_FAILED',
  unregisteredEventType: 'UNREGISTERED_EVENT_TYPE',
  webhookHttpError: 'WEBHOOK_HTTP_ERROR',
  webhookNetworkError: 'WEBHOOK_NETWORK_ERROR',
  claimExpiryFailed: 'CLAIM_EXPIRY_FAILED',
} as const);

export type RelayDiagnosticCode = (typeof RELAY_DIAGNOSTIC_CODE)[keyof typeof RELAY_DIAGNOSTIC_CODE];

export interface RelayDiagnostic {
  readonly code: RelayDiagnosticCode;
  readonly token: string;
  readonly httpStatus?: number;
}

function diagnosticMaterial(error: unknown): string {
  try {
    if (error instanceof Error) {
      const message = error.message;
      return typeof message === 'string' ? message : 'uninspectable-relay-error';
    }
    if (typeof error === 'string') return error;
    if (
      error === null ||
      error === undefined ||
      typeof error === 'number' ||
      typeof error === 'bigint' ||
      typeof error === 'boolean'
    ) {
      return `${typeof error}:${String(error)}`;
    }
  } catch {
    // A hostile Error subclass may expose a throwing message getter. It still
    // receives a stable opaque token without invoking arbitrary serializers.
  }
  return 'uninspectable-relay-error';
}

function normalizedHttpStatus(httpStatus: number | undefined): number | undefined {
  return httpStatus !== undefined && Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599
    ? httpStatus
    : undefined;
}

/** Convert an arbitrary failure into a stable, non-reversible diagnostic. */
export function createRelayDiagnostic(
  code: RelayDiagnosticCode,
  error: unknown,
  details: { readonly httpStatus?: number } = {},
): RelayDiagnostic {
  const token = `sha256:${createHash('sha256').update(diagnosticMaterial(error)).digest('hex')}`;
  const httpStatus = normalizedHttpStatus(details.httpStatus);
  return Object.freeze({
    code,
    ...(httpStatus === undefined ? {} : { httpStatus }),
    token,
  });
}

/** Canonical compact representation used by both lastError and relay logs. */
export function serializeRelayDiagnostic(diagnostic: RelayDiagnostic): string {
  return JSON.stringify({
    code: diagnostic.code,
    ...(diagnostic.httpStatus === undefined ? {} : { httpStatus: diagnostic.httpStatus }),
    token: diagnostic.token,
  });
}
