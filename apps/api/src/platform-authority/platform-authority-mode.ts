/**
 * Platform schedule authority mode switch (M10-PR3).
 *
 * - `r4` (default): 100% backward-compatible R4 capability + 7-day deployment-binding
 *   + 5 RSA keyrings + RS256 platform execution grants.
 * - `internal_db`: lightweight internal DB Kill Switch via `platform_schedule_config`
 *   (no 7-day deployment-binding.json, no 5 RSA keyrings, no R4 JWKS polling).
 *
 * Any unrecognized value fails closed so typos never silently relax authority checks.
 */

export const PLATFORM_AUTHORITY_MODE_ENV = "PLATFORM_AUTHORITY_MODE" as const;

export type PlatformAuthorityMode = "r4" | "internal_db";

export function resolvePlatformAuthorityMode(
  env: NodeJS.ProcessEnv = process.env,
): PlatformAuthorityMode {
  const raw = env[PLATFORM_AUTHORITY_MODE_ENV];
  if (raw === undefined || raw.trim() === "") {
    return "r4";
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "r4") return "r4";
  if (normalized === "internal_db") return "internal_db";
  throw new Error(`PLATFORM_AUTHORITY_MODE_INVALID:${raw.trim()}`);
}

export function isInternalDbPlatformAuthorityMode(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolvePlatformAuthorityMode(env) === "internal_db";
}
