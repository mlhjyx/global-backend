import { BadRequestException } from '@nestjs/common';

export const IDEMPOTENCY_KEY_PATTERN_SOURCE = '[A-Za-z0-9._:-]{1,128}';
const IDEMPOTENCY_KEY_PATTERN = new RegExp(
  `^${IDEMPOTENCY_KEY_PATTERN_SOURCE}$`,
);

export function normalizeIdempotencyKey(
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (value !== normalized || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new BadRequestException({
      error: {
        code: 'INVALID_IDEMPOTENCY_KEY',
        message:
          'idempotency-key must contain 1–128 letters, digits, dots, underscores, colons, or hyphens',
      },
    });
  }
  return normalized;
}
