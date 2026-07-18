export const CANONICAL_CLAIM_FACT_KEY_SOURCE =
  '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$';

export const CANONICAL_CLAIM_FACT_KEY_PATTERN = new RegExp(
  CANONICAL_CLAIM_FACT_KEY_SOURCE,
  'u',
);

export function isCanonicalClaimFactKey(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 120 &&
    CANONICAL_CLAIM_FACT_KEY_PATTERN.test(value)
  );
}

export function assertCanonicalClaimFactKey(value: string): string {
  if (!isCanonicalClaimFactKey(value)) {
    throw new Error(
      'Claim factKey must be strict lower_snake_case (1-120 ASCII characters)',
    );
  }
  return value;
}
