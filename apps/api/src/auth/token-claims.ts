const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLAIM_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/;
const RESERVED_CLAIM_NAMES = new Set([
  '__proto__',
  'aud',
  'constructor',
  'exp',
  'iat',
  'iss',
  'jti',
  'nbf',
  'prototype',
  'sub',
]);
function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 31 || codePoint === 127) return true;
  }
  return false;
}

export function normalizeSubjectClaim(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    value !== value.trim() ||
    containsControlCharacter(value)
  ) {
    throw new Error('subject claim is invalid');
  }
  return value;
}

export function normalizeWorkspaceClaim(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error('workspace claim must be a UUID');
  }
  return value.toLowerCase();
}

export function resolveTokenClaimName(
  configured: string | undefined,
  fallback: string,
): string {
  const candidate = configured === undefined ? fallback : configured;
  if (
    RESERVED_CLAIM_NAMES.has(candidate) ||
    !CLAIM_NAME_PATTERN.test(candidate)
  ) {
    throw new Error('token claim name is invalid');
  }
  return candidate;
}

export function resolveClockToleranceSeconds(
  configured: string | undefined,
): number {
  if (configured === undefined) return 60;
  if (!/^\d{1,3}$/.test(configured)) {
    throw new Error('AUTH_CLOCK_SKEW_S must be an integer from 0 to 300');
  }
  const seconds = Number(configured);
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 300) {
    throw new Error('AUTH_CLOCK_SKEW_S must be an integer from 0 to 300');
  }
  return seconds;
}
