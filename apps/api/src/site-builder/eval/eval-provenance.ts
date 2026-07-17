import { createHash } from 'node:crypto';

/**
 * Deterministic JSON serialization for evaluator provenance fingerprints.
 * Arrays retain their semantic order; object keys are sorted recursively so a
 * hash does not change merely because a source object was constructed in a
 * different insertion order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`);
    return `{${entries.join(',')}}`;
  }

  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string') {
    throw new Error('evaluator provenance must be JSON-serializable');
  }
  return serialized;
}

export function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256CanonicalJson(value: unknown): string {
  return sha256Text(canonicalJson(value));
}
