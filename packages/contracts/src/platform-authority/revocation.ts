import { z } from "zod";

export const PLATFORM_AUTHORITY_REVOCATION_TYPE = "execution-budget-authority-revocation+jwt" as const;
export const PLATFORM_AUTHORITY_FENCE_ACK_TYPE = "platform-authority-fence-ack+jwt" as const;
export const PLATFORM_AUTHORITY_FENCE_ACK_AUDIENCE = "growthos:platform-authority-fence-ack" as const;

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const schedule = z.enum(["acq-sweep", "intent-sweep", "sanctions-refresh", "patents-cache-refresh"]);
const numericDate = z.number().int().nonnegative().max(253402300799);
const decimal = z.string().max(19).regex(/^(0|[1-9][0-9]*)$/)
  .refine(value => value.length < 19 || value <= "9223372036854775807");
const positiveDecimal = decimal.refine(value => value !== "0");
const issuer = z.string().min(1).max(2048).refine(value => {
  try {
    if (/[\u0000-\u0020\u007f]/.test(value)) return false;
    const uri = new URL(value);
    return !uri.username && !uri.password && !uri.search && !uri.hash &&
      (uri.protocol === "https:" || (uri.protocol === "http:" && ["127.0.0.1", "localhost"].includes(uri.hostname)));
  } catch { return false; }
});
const times = { iat: numericDate, nbf: numericDate, exp: numericDate };
function boundedWindow(value: { iat: number; nbf: number; exp: number }): boolean {
  return value.iat <= value.nbf && value.nbf < value.exp && value.exp - value.iat <= 300;
}

/** Payload validation only: callers MUST separately verify RS256, typ, trust and current time. */
export const PlatformAuthorityRevocationClaimsSchema = z.object({
  schema_version: z.literal("PlatformExecutionBudgetAuthorityRevoked/v1"),
  iss: issuer,
  aud: z.literal("global-backend:execution-budget"),
  revocation_jti: uuid,
  target_issuer: issuer,
  target_jti: uuid,
  schedule_id: schedule,
  workflow_run_id: uuid,
  fence_sequence: positiveDecimal,
  reason_code: z.enum(["POLICY_DISABLED", "SECURITY_RESPONSE", "OPERATOR_HOLD"]),
  ...times,
}).strict().refine(boundedWindow).refine(value => value.iss === value.target_issuer);

/** ACKs have a separate key, JOSE type and audience; this schema is not signature evidence. */
export const PlatformAuthorityFenceAckClaimsSchema = z.object({
  schema_version: z.literal("PlatformExecutionBudgetFenceAcknowledged/v1"),
  iss: issuer,
  aud: z.literal(PLATFORM_AUTHORITY_FENCE_ACK_AUDIENCE),
  jti: uuid,
  revocation_jti: uuid,
  command_sha256: digest,
  schedule_id: schedule,
  fence_sequence: positiveDecimal,
  backend_generation: positiveDecimal,
  committed_at: numericDate,
  in_flight_attempts: decimal,
  ...times,
}).strict().refine(boundedWindow).refine(value => value.committed_at <= value.iat);

export type PlatformAuthorityRevocationClaims = z.infer<typeof PlatformAuthorityRevocationClaimsSchema>;
export type PlatformAuthorityFenceAckClaims = z.infer<typeof PlatformAuthorityFenceAckClaimsSchema>;
