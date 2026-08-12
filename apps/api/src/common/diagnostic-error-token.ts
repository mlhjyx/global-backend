import { createHash } from 'node:crypto';

/**
 * Reduce an untrusted provider diagnostic to an irreversible correlation token.
 * Provider response bodies can contain echoed queries, identifiers or personal data.
 */
export function diagnosticErrorToken(value: unknown): string {
  const candidate = value instanceof Error ? value.message : value;
  const text =
    typeof candidate === 'string'
      ? candidate
      : candidate === undefined
        ? 'undefined'
        : candidate === null
          ? 'null'
          : String(candidate);
  return `ERROR_TEXT_SHA256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}
