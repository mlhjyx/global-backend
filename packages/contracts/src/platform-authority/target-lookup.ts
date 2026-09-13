import { z } from "zod";
import {
  platformAuthorityUuid,
  platformAuthoritySchedule,
  platformAuthorityNumericDate,
  platformAuthorityIssuer,
  platformAuthorityBoundedTokenWindow,
} from "./payload-fields";

export const PLATFORM_AUTHORITY_TARGET_LOOKUP_OPERATION_ID =
  "platformAuthorityTargetLookup_v1" as const;
export const PLATFORM_AUTHORITY_TARGET_READER_TYPE =
  "platform-authority-target-reader+jwt" as const;
export const PLATFORM_AUTHORITY_TARGET_READER_AUDIENCE =
  "global-backend:platform-authority-target-read" as const;
export const PLATFORM_AUTHORITY_TARGET_READER_SCOPE =
  "platform-authority.target.read" as const;
export const PLATFORM_AUTHORITY_TARGET_OBSERVATION_VERSION =
  "platform-authority-target-observation/v1" as const;

/** Syntax only. The consumer must authenticate the caller and bind its configured issuer. */
export const PlatformAuthorityTargetLookupRequestSchema = z
  .object({
    target_issuer: platformAuthorityIssuer,
    target_jti: platformAuthorityUuid,
    schedule_id: platformAuthoritySchedule,
    workflow_run_id: platformAuthorityUuid,
    nonce: z.string().regex(/^[0-9a-f]{32}$/),
  })
  .strict();

/** A successful locator observation, never a signed proof or fence ACK.
 * The consumer must enforce HTTPS origin, in-flight nonce/tuple and freshness;
 * request/response byte limits belong to transport, not parsed object schemas.
 * No found=false response contract is implied by this successful shape. */
export const PlatformAuthorityTargetObservationSchema =
  PlatformAuthorityTargetLookupRequestSchema.extend({
    schema_version: z.literal(PLATFORM_AUTHORITY_TARGET_OBSERVATION_VERSION),
    found: z.literal(true),
    observed_at: platformAuthorityNumericDate,
  }).strict();

/** Payload arithmetic only: not a JWT decoder, signature check or current-time proof.
 * Authentication must separately check RS256/typ/kid, bounded duplicate-safe wire,
 * configured issuer/sub, exact audience/scope, iat/nbf skew and strict now < exp.
 * sub is deployment-owned; its nonempty syntax does not authenticate that identity. */
export const PlatformAuthorityTargetReaderClaimsSchema = z
  .object({
    iss: platformAuthorityIssuer,
    aud: z.literal(PLATFORM_AUTHORITY_TARGET_READER_AUDIENCE),
    sub: z.string().min(1),
    scope: z.literal(PLATFORM_AUTHORITY_TARGET_READER_SCOPE),
    jti: platformAuthorityUuid,
    iat: platformAuthorityNumericDate,
    nbf: platformAuthorityNumericDate,
    exp: platformAuthorityNumericDate,
  })
  .strict()
  .refine(platformAuthorityBoundedTokenWindow);

export type PlatformAuthorityTargetLookupRequest = z.infer<
  typeof PlatformAuthorityTargetLookupRequestSchema
>;
export type PlatformAuthorityTargetObservation = z.infer<
  typeof PlatformAuthorityTargetObservationSchema
>;
export type PlatformAuthorityTargetReaderClaims = z.infer<
  typeof PlatformAuthorityTargetReaderClaimsSchema
>;
