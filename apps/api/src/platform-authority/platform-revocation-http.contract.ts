export const PLATFORM_REVOCATION_HTTP_PATH =
  "/api/v1/platform-authority/revocations";
export const PLATFORM_FENCE_ACK_JWKS_PATH =
  "/api/v1/platform-authority/fence-ack-jwks";
export const PLATFORM_REVOCATION_HTTP_DEADLINE_MS = 25_000;
export const PLATFORM_REVOCATION_HTTP_MAX_BYTES = 16_384;
export const PLATFORM_REVOCATION_HTTP_ERRORS = {
  invalid: { status: 400, code: "PLATFORM_REVOCATION_REQUEST_INVALID" },
  denied: { status: 401, code: "PLATFORM_REVOCATION_INVALID" },
  scope: { status: 403, code: "PLATFORM_REVOCATION_SCOPE_MISMATCH" },
  expired: { status: 409, code: "PLATFORM_REVOCATION_EXPIRED" },
  reused: { status: 409, code: "PLATFORM_REVOCATION_REUSED" },
  sequenceConflict: {
    status: 409,
    code: "PLATFORM_REVOCATION_SEQUENCE_CONFLICT",
  },
  rateLimited: { status: 429, code: "PLATFORM_REVOCATION_RATE_LIMITED" },
  unavailable: { status: 503, code: "PLATFORM_REVOCATION_UNAVAILABLE" },
} as const;
export type RevocationHttpErrorKind =
  keyof typeof PLATFORM_REVOCATION_HTTP_ERRORS;
export class PlatformRevocationHttpError extends Error {
  constructor(readonly kind: RevocationHttpErrorKind) {
    super(PLATFORM_REVOCATION_HTTP_ERRORS[kind].code);
  }
}
export function revocationFailure(
  kind: RevocationHttpErrorKind = "unavailable",
): never {
  throw new PlatformRevocationHttpError(kind);
}
export function revocationErrorBody(kind: RevocationHttpErrorKind) {
  return {
    error: {
      code: PLATFORM_REVOCATION_HTTP_ERRORS[kind].code,
      message: "platform revocation request cannot be completed",
    },
  };
}
export interface RevocationHttpInput {
  method: unknown;
  originalUrl: unknown;
  rawHeaders: unknown;
  rawBody: unknown;
}
export function parsePlatformRevocationHeaders(
  input: Omit<RevocationHttpInput, "rawBody">,
): number {
  if (
    input.method !== "POST" ||
    input.originalUrl !== PLATFORM_REVOCATION_HTTP_PATH ||
    !Array.isArray(input.rawHeaders) ||
    input.rawHeaders.length % 2 ||
    input.rawHeaders.length > 128
  )
    return revocationFailure("invalid");
  const headers = new Map<string, string>();
  let size = 0;
  for (let index = 0; index < input.rawHeaders.length; index += 2) {
    const name = input.rawHeaders[index],
      value = input.rawHeaders[index + 1];
    if (
      typeof name !== "string" ||
      typeof value !== "string" ||
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
      // eslint-disable-next-line no-control-regex -- Reject all HTTP control bytes explicitly.
      /[\x00-\x1f\x7f]/.test(value)
    )
      return revocationFailure("invalid");
    size += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    const lower = name.toLowerCase();
    if (size > 32768 || headers.has(lower)) return revocationFailure("invalid");
    headers.set(lower, value);
  }
  if (
    headers.get("content-type") !== "application/jose" ||
    [
      "authorization",
      "cookie",
      "cookie2",
      "transfer-encoding",
      "content-encoding",
    ].some((k) => headers.has(k))
  )
    return revocationFailure("invalid");
  const length = headers.get("content-length");
  if (
    !length ||
    !/^[1-9][0-9]{0,4}$/.test(length) ||
    Number(length) > PLATFORM_REVOCATION_HTTP_MAX_BYTES
  )
    return revocationFailure("invalid");
  return Number(length);
}
export function parsePlatformRevocationRequest(
  input: RevocationHttpInput,
): string {
  const length = parsePlatformRevocationHeaders(input);
  if (!Buffer.isBuffer(input.rawBody) || input.rawBody.length !== length)
    return revocationFailure("invalid");
  const compact = input.rawBody.toString("ascii");
  if (
    !Buffer.from(compact, "ascii").equals(input.rawBody) ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(compact)
  )
    return revocationFailure("invalid");
  return compact;
}
