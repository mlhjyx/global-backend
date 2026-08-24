export const MAX_MICROUSD = 9_223_372_036_854_775_807n;
const CANONICAL_NON_NEGATIVE_INTEGER = /^(0|[1-9][0-9]*)$/;

export function assertMicrousd(
  name: string,
  value: bigint,
  options: { allowZero?: boolean } = {},
): bigint {
  if (
    typeof value !== 'bigint' ||
    value < (options.allowZero === false ? 1n : 0n) ||
    value > MAX_MICROUSD
  ) {
    throw new RangeError(
      `${name} must be a ${options.allowZero === false ? 'positive' : 'non-negative'} PostgreSQL BIGINT microusd amount`,
    );
  }
  return value;
}

export function parseCanonicalMicrousd(
  name: string,
  value: string,
  options: { allowZero?: boolean } = {},
): bigint {
  if (
    typeof value !== 'string' ||
    !CANONICAL_NON_NEGATIVE_INTEGER.test(value)
  ) {
    throw new TypeError(`${name} must be a canonical decimal microusd string`);
  }
  return assertMicrousd(name, BigInt(value), options);
}

export function canonicalMicrousd(name: string, value: bigint): string {
  return assertMicrousd(name, value).toString(10);
}

export function centsToMicrousd(cents: number): bigint {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new TypeError('cents must be a non-negative safe integer');
  }
  return assertMicrousd('converted cents', BigInt(cents) * 10_000n);
}

function decimalRational(raw: string): {
  numerator: bigint;
  denominator: bigint;
} {
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(raw);
  if (!match) throw new TypeError('USD amount must be a non-negative decimal');
  const whole = match[1]!;
  const fraction = match[2] ?? '';
  const exponent = Number(match[3] ?? '0');
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 10_000) {
    throw new RangeError('USD exponent is outside the supported range');
  }
  const coefficient = BigInt(`${whole}${fraction}`);
  const decimalExponent = exponent - fraction.length;
  if (decimalExponent >= 0) {
    return {
      numerator: coefficient * 10n ** BigInt(decimalExponent),
      denominator: 1n,
    };
  }
  return {
    numerator: coefficient,
    denominator: 10n ** BigInt(-decimalExponent),
  };
}

function decimalToScaledCeil(raw: string, scale: number): bigint {
  const { numerator, denominator } = decimalRational(raw);
  const scaled = numerator * 10n ** BigInt(scale);
  return (scaled + denominator - 1n) / denominator;
}

/** Convert an exact decimal USD observation, rounding any sub-microusd spend up. */
export function usdToMicrousdCeil(usd: string): bigint {
  if (typeof usd !== 'string') {
    throw new TypeError('USD amount must be an exact decimal string');
  }
  return assertMicrousd(
    'converted USD',
    decimalToScaledCeil(usd, 6),
  );
}
