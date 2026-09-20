import { timingSafeEqual } from "node:crypto";

export const DEFAULT_MODEL_GATEWAY_REQUEST_TIMEOUT_MS = 180_000;
export const MAX_MODEL_GATEWAY_REQUEST_TIMEOUT_MS = 300_000;
const MIN_MODEL_GATEWAY_REQUEST_TIMEOUT_MS = 1_000;
const CANONICAL_MILLISECONDS = /^(?:0|[1-9][0-9]*)$/u;

/**
 * Secrets are never normalized on behalf of an operator. HTTP header stacks
 * can trim surrounding whitespace, so accepting padded environment values
 * would make byte-different configuration strings identical on the wire.
 */
export function canonicalGatewayCredential(
  value: string | undefined,
): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    return undefined;
  }
  return value;
}

export function gatewayCredentialsAreDistinct(
  dispatchCredential: string,
  readbackCredential: string,
): boolean {
  const dispatch = Buffer.from(dispatchCredential, "utf8");
  const readback = Buffer.from(readbackCredential, "utf8");
  return (
    dispatch.length !== readback.length || !timingSafeEqual(dispatch, readback)
  );
}

export function isBoundedModelGatewayRequestTimeout(
  value: unknown,
): value is number {
  return (
    Number.isSafeInteger(value) &&
    Number(value) >= MIN_MODEL_GATEWAY_REQUEST_TIMEOUT_MS &&
    Number(value) <= MAX_MODEL_GATEWAY_REQUEST_TIMEOUT_MS
  );
}

export function parseModelGatewayRequestTimeout(
  value: string | undefined,
): number | undefined {
  if (value === undefined) return DEFAULT_MODEL_GATEWAY_REQUEST_TIMEOUT_MS;
  if (!CANONICAL_MILLISECONDS.test(value)) return undefined;
  const parsed = Number(value);
  return isBoundedModelGatewayRequestTimeout(parsed) ? parsed : undefined;
}
